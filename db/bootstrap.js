const crypto = require('node:crypto');
const { hashPassword } = require('../lib/passwords');

async function bootstrapAdmin(pool, config) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const { rows } = await client.query('SELECT count(*) FROM users');
    if (Number(rows[0].count) > 0) {
      await client.query('COMMIT');
      return false;
    }
    const passwordHash = await hashPassword(config.bootstrapAdminPassword);
    await client.query(
      'INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [crypto.randomUUID(), config.bootstrapAdminEmail.toLowerCase(), passwordHash, 'admin'],
    );
    await client.query('COMMIT');
    return true;
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
    const created = await bootstrapAdmin(pool, config);
    console.log(created ? 'Administrator awal dibuat.' : 'Administrator sudah ada; tidak ada perubahan.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Pembuatan administrator gagal:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { bootstrapAdmin };
