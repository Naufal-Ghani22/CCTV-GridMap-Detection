const path = require('node:path');

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} wajib diisi.`);
  }
  return value.trim();
}

function parseEncryptionKey(value) {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('RTSP_ENCRYPTION_KEY harus berupa base64 untuk tepat 32 byte.');
  }
  return key;
}

function loadConfig(env = process.env) {
  const databaseUrl = requireValue(env, 'DATABASE_URL');
  let parsedUrl;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL bukan URL PostgreSQL yang valid.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
    throw new Error('DATABASE_URL harus menggunakan protokol PostgreSQL.');
  }

  return Object.freeze({
    databaseUrl,
    sessionSecret: requireValue(env, 'SESSION_SECRET'),
    rtspEncryptionKey: parseEncryptionKey(requireValue(env, 'RTSP_ENCRYPTION_KEY')),
    bootstrapAdminEmail: requireValue(env, 'BOOTSTRAP_ADMIN_EMAIL'),
    bootstrapAdminPassword: requireValue(env, 'BOOTSTRAP_ADMIN_PASSWORD'),
  });
}

function loadEnvironment() {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  return loadConfig(process.env);
}

module.exports = { loadConfig, loadEnvironment };
