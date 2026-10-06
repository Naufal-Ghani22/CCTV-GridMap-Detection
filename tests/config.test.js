const assert = require('node:assert/strict');
const test = require('node:test');

const { loadConfig } = require('../config');

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://cctv_app:secret@127.0.0.1:5432/cctv_grid_map',
  SESSION_SECRET: 'session-secret-for-tests',
  RTSP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  BOOTSTRAP_ADMIN_EMAIL: 'admin@example.test',
  BOOTSTRAP_ADMIN_PASSWORD: 'a-long-bootstrap-password',
};

test('rejects a production configuration without database or encryption secrets', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /DATABASE_URL/);
});

test('loads mandatory server-only database settings', () => {
  const config = loadConfig(validEnvironment);
  assert.equal(config.databaseUrl, validEnvironment.DATABASE_URL);
  assert.equal(config.rtspEncryptionKey.length, 32);
  assert.equal(Object.isFrozen(config), true);
});

test('rejects an RTSP encryption key that is not a 32-byte base64 value', () => {
  assert.throws(() => loadConfig({ ...validEnvironment, RTSP_ENCRYPTION_KEY: 'not-a-key' }), /RTSP_ENCRYPTION_KEY/);
});
