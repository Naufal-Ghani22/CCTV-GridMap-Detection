const { Pool } = require('pg');

function createPool(connectionString) {
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Koneksi database harus menggunakan URL PostgreSQL.');
  }
  return new Pool({
    connectionString,
    max: 10,
    application_name: 'cctv-grid-map',
  });
}

module.exports = { createPool };
