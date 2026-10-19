const crypto = require('node:crypto');

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(pool, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await pool.query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [tokenDigest(token), userId, expiresAt],
  );
  return { token, expiresAt };
}

async function getSessionUser(pool, token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const result = await pool.query(
    `SELECT users.id, users.email, users.role, users.display_name, users.division
       FROM sessions
       JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = $1 AND sessions.expires_at > now() AND users.is_active`,
    [tokenDigest(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email, role: row.role, name: row.display_name || row.email.split('@')[0], division: row.division || '' };
}

async function pruneExpiredSessions(pool) {
  const result = await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
  return result.rowCount || 0;
}

module.exports = { createSession, getSessionUser, pruneExpiredSessions, tokenDigest };
