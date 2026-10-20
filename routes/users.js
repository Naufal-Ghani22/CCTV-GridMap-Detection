const crypto = require('node:crypto');
const { audit, inTransaction } = require('../lib/audit');
const { HttpError, clearSessionCookie, readJson, sendJson, sendSessionCookie, sessionToken } = require('../lib/http');
const { hashPassword, verifyPassword } = require('../lib/passwords');
const { createSession, tokenDigest } = require('../lib/sessions');

const ROLES = ['admin', 'operator'];
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

function userResponse(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    name: row.display_name || row.email.split('@')[0],
    division: row.division || '',
    isActive: row.is_active !== false,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function textField(value, label, max) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_user', `${label} harus berupa teks.`);
  return value.trim().slice(0, max);
}

function passwordField(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length < 12 || value.length > 200) throw new HttpError(400, 'weak_password', 'Kata sandi minimal 12 karakter.');
  return value;
}

// --- Authentication -------------------------------------------------------

async function login({ request, response, deps }) {
  const data = await readJson(request);
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  const password = typeof data.password === 'string' ? data.password : '';
  if (!email || !password) throw new HttpError(400, 'invalid_credentials', 'Masukkan email dan kata sandi.');

  const ip = request.socket.remoteAddress || 'unknown';
  const attempt = deps.loginLimiter.hit(`${ip}|${email}`);
  const ipAttempt = deps.loginIpLimiter.hit(ip);
  if (!attempt.allowed || !ipAttempt.allowed) {
    const wait = Math.max(attempt.retryAfterSec, ipAttempt.retryAfterSec);
    response.setHeader('Retry-After', String(wait));
    throw new HttpError(429, 'too_many_attempts', `Terlalu banyak percobaan masuk. Coba lagi dalam ${Math.ceil(wait / 60)} menit.`);
  }

  const user = (await deps.pool.query('SELECT id, email, password_hash, role, display_name, division, is_active FROM users WHERE email = $1', [email])).rows[0];
  if (!user || user.is_active === false || !await verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'invalid_credentials', 'Email atau kata sandi tidak sesuai.');
  }
  deps.loginLimiter.reset(`${ip}|${email}`);
  const { token } = await createSession(deps.pool, user.id);
  sendSessionCookie(response, token);
  await audit(deps.pool, { actorId: user.id, action: 'Masuk ke sistem', subjectType: 'user', subjectId: user.id, text: user.email }).catch(() => {});
  return sendJson(response, 200, { user: { id: user.id, email: user.email, role: user.role, name: user.display_name || user.email.split('@')[0], division: user.division || '' } });
}

async function session({ response, user }) {
  return sendJson(response, 200, { user: user || null });
}

async function logout({ request, response, deps }) {
  const token = sessionToken(request);
  if (token && deps.pool) await deps.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenDigest(token)]);
  clearSessionCookie(response);
  return sendJson(response, 204);
}

// --- Own profile ----------------------------------------------------------

async function updateMe({ request, response, user, deps }) {
  const data = await readJson(request, 4 * 1024);
  const name = textField(data.name, 'Nama', 80);
  const division = textField(data.division, 'Divisi', 60);
  const newPassword = passwordField(data.newPassword);
  if (newPassword) {
    const row = (await deps.pool.query('SELECT password_hash FROM users WHERE id = $1', [user.id])).rows[0];
    if (!row || !await verifyPassword(String(data.currentPassword || ''), row.password_hash)) {
      throw new HttpError(400, 'wrong_password', 'Kata sandi saat ini tidak sesuai.');
    }
  }
  const row = await inTransaction(deps.pool, async (client) => {
    const updated = (await client.query(
      `UPDATE users SET display_name = COALESCE($1, display_name), division = COALESCE($2, division), updated_at = now()
        WHERE id = $3 RETURNING id, email, role, display_name, division, is_active, created_at`,
      [name ?? null, division ?? null, user.id],
    )).rows[0];
    if (newPassword) {
      await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [await hashPassword(newPassword), user.id]);
      // Sign out other browsers; keep the current one.
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, tokenDigest(sessionToken(request) || '')]);
    }
    await audit(client, { actorId: user.id, action: newPassword ? 'Mengganti kata sandi' : 'Memperbarui profil', subjectType: 'user', subjectId: user.id, text: updated.email });
    return updated;
  });
  deps.hub.broadcast('users', {});
  return sendJson(response, 200, { user: userResponse(row) });
}

// --- Account administration ----------------------------------------------

async function list({ response, deps }) {
  const result = await deps.pool.query('SELECT id, email, role, display_name, division, is_active, created_at FROM users ORDER BY role, email');
  return sendJson(response, 200, result.rows.map(userResponse));
}

async function create({ request, response, user, deps }) {
  const data = await readJson(request, 4 * 1024);
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_user', 'Email petugas tidak valid.');
  if (!ROLES.includes(data.role)) throw new HttpError(400, 'invalid_user', 'Peran harus admin atau operator.');
  const password = passwordField(data.password);
  if (!password) throw new HttpError(400, 'weak_password', 'Kata sandi awal minimal 12 karakter.');
  const name = textField(data.name, 'Nama', 80) || email.split('@')[0];
  const division = textField(data.division, 'Divisi', 60) || '';
  try {
    const row = await inTransaction(deps.pool, async (client) => {
      const created = (await client.query(
        'INSERT INTO users (id, email, password_hash, role, display_name, division) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, display_name, division, is_active, created_at',
        [crypto.randomUUID(), email, await hashPassword(password), data.role, name, division],
      )).rows[0];
      await audit(client, { actorId: user.id, action: 'Menambah akun', subjectType: 'user', subjectId: created.id, text: `${email} · ${data.role}` });
      return created;
    });
    deps.hub.broadcast('users', {});
    deps.hub.broadcast('history', {});
    return sendJson(response, 201, userResponse(row));
  } catch (error) {
    if (error.code === '23505') throw new HttpError(409, 'duplicate_user', 'Email sudah terdaftar.');
    throw error;
  }
}

async function activeAdminCount(client, exceptId) {
  return (await client.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active AND id <> $1", [exceptId])).rows[0].n;
}

async function update({ request, response, params, user, deps }) {
  const id = params[0];
  const data = await readJson(request, 4 * 1024);
  const name = textField(data.name, 'Nama', 80);
  const division = textField(data.division, 'Divisi', 60);
  const password = passwordField(data.password);
  if (data.role !== undefined && !ROLES.includes(data.role)) throw new HttpError(400, 'invalid_user', 'Peran harus admin atau operator.');
  if (data.isActive !== undefined && typeof data.isActive !== 'boolean') throw new HttpError(400, 'invalid_user', 'Status akun tidak valid.');
  const row = await inTransaction(deps.pool, async (client) => {
    const current = (await client.query('SELECT id, email, role, is_active FROM users WHERE id::text = $1 FOR UPDATE', [id])).rows[0];
    if (!current) throw new HttpError(404, 'user_not_found', 'Akun tidak ditemukan.');
    const demoting = current.role === 'admin' && ((data.role && data.role !== 'admin') || data.isActive === false);
    if (demoting && !await activeAdminCount(client, current.id)) throw new HttpError(409, 'last_admin', 'Minimal harus ada satu administrator aktif.');
    const updated = (await client.query(
      `UPDATE users SET display_name = COALESCE($1, display_name), division = COALESCE($2, division), role = COALESCE($3, role),
              is_active = COALESCE($4, is_active), updated_at = now()
        WHERE id = $5 RETURNING id, email, role, display_name, division, is_active, created_at`,
      [name ?? null, division ?? null, data.role ?? null, data.isActive ?? null, current.id],
    )).rows[0];
    if (password) await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(password), current.id]);
    if (password || data.isActive === false || (data.role && data.role !== current.role)) await client.query('DELETE FROM sessions WHERE user_id = $1', [current.id]);
    const parts = [data.role && data.role !== current.role ? `peran ${data.role}` : '', data.isActive === false ? 'dinonaktifkan' : data.isActive === true && !current.is_active ? 'diaktifkan' : '', password ? 'kata sandi direset' : ''].filter(Boolean);
    await audit(client, { actorId: user.id, action: 'Memperbarui akun', subjectType: 'user', subjectId: current.id, text: `${current.email}${parts.length ? ` · ${parts.join(', ')}` : ''}` });
    return updated;
  });
  deps.hub.broadcast('users', {});
  deps.hub.broadcast('history', {});
  return sendJson(response, 200, userResponse(row));
}

async function remove({ response, params, user, deps }) {
  const id = params[0];
  if (id === user.id) throw new HttpError(409, 'cannot_delete_self', 'Akun yang sedang dipakai tidak dapat dihapus.');
  await inTransaction(deps.pool, async (client) => {
    const current = (await client.query('SELECT id, email, role FROM users WHERE id::text = $1 FOR UPDATE', [id])).rows[0];
    if (!current) throw new HttpError(404, 'user_not_found', 'Akun tidak ditemukan.');
    if (current.role === 'admin' && !await activeAdminCount(client, current.id)) throw new HttpError(409, 'last_admin', 'Minimal harus ada satu administrator aktif.');
    await client.query('DELETE FROM users WHERE id = $1', [current.id]);
    await audit(client, { actorId: user.id, action: 'Menghapus akun', subjectType: 'user', text: current.email });
  });
  deps.hub.broadcast('users', {});
  deps.hub.broadcast('history', {});
  return sendJson(response, 204);
}

module.exports = { create, list, login, logout, remove, session, update, updateMe, userResponse };
