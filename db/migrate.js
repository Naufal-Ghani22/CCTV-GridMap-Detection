const fs = require('node:fs/promises');
const path = require('node:path');

async function migrate(pool) {
  const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

async function main() {
  const { loadEnvironment } = require('../config');
  const { createPool } = require('./client');
  const pool = createPool(loadEnvironment().databaseUrl);
  try {
    await migrate(pool);
    console.log('Struktur database sudah diperbarui.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Migrasi database gagal:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
