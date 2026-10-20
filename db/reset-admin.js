const crypto = require('node:crypto');
const { hashPassword } = require('../lib/passwords');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

async function resetAdmin(pool, config) {
  const email = config.bootstrapAdminEmail.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL harus berupa alamat email, misalnya admin@bandara.local.');
  }
  const passwordHash = await hashPassword(config.bootstrapAdminPassword);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      "UPDATE users SET password_hash = $1, role = 'admin', updated_at = now() WHERE email = $2 RETURNING id",
      [passwordHash, email],
    );
    let userId = updated.rows[0]?.id;
    if (!userId) {
      userId = crypto.randomUUID();
      await client.query(
        'INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)',
        [userId, email, passwordHash, 'admin'],
      );
    }
    await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    // Accounts without a valid email can never pass the browser login form, so they are leftovers.
    const removed = await client.query(
      "DELETE FROM users WHERE id <> $1 AND email !~ '^[^[:space:]@]+@[^[:space:]@]+$' RETURNING email",
      [userId],
    );
    await client.query('COMMIT');
    return { email, created: !updated.rows[0], removed: removed.rows.map((row) => row.email) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const { loadEnvironment } = require('../config');
  const { createPool } = require('./client');
  const config = loadEnvironment();
  const pool = createPool(config.databaseUrl);
  try {
    const result = await resetAdmin(pool, config);
    console.log(result.created
      ? `Administrator ${result.email} dibuat.`
      : `Kata sandi administrator ${result.email} diperbarui.`);
    if (result.removed.length) console.log(`Akun tidak valid dihapus: ${result.removed.join(', ')}`);
    console.log('Silakan masuk dengan email dan kata sandi dari .env.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Reset administrator gagal:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { resetAdmin };
