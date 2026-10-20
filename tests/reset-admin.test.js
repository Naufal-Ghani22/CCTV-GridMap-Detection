const assert = require('node:assert/strict');
const { test } = require('node:test');

const { verifyPassword } = require('../lib/passwords');
const { resetAdmin } = require('../db/reset-admin');

function fakePool(existingId = null) {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('UPDATE users')) return { rows: existingId ? [{ id: existingId }] : [] };
      if (sql.startsWith('DELETE FROM users')) return { rows: [{ email: 'email-admin-anda' }] };
      return { rows: [] };
    },
    release() {},
  };
  return { calls, pool: { connect: async () => client } };
}

const config = { bootstrapAdminEmail: ' Admin@Bandara.local ', bootstrapAdminPassword: 'kata-sandi-baru-123' };

test('creates the administrator when the email is not stored yet', async () => {
  const { calls, pool } = fakePool();
  const result = await resetAdmin(pool, config);
  assert.equal(result.email, 'admin@bandara.local');
  assert.equal(result.created, true);
  assert.deepEqual(result.removed, ['email-admin-anda']);
  const insert = calls.find((call) => call.sql.startsWith('INSERT INTO users'));
  assert.equal(insert.values[1], 'admin@bandara.local');
  assert.equal(await verifyPassword('kata-sandi-baru-123', insert.values[2]), true);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('updates the password of an existing administrator and clears its sessions', async () => {
  const { calls, pool } = fakePool('user-1');
  const result = await resetAdmin(pool, config);
  assert.equal(result.created, false);
  assert.equal(calls.some((call) => call.sql.startsWith('INSERT INTO users')), false);
  const sessions = calls.find((call) => call.sql.startsWith('DELETE FROM sessions'));
  assert.deepEqual(sessions.values, ['user-1']);
});

test('rejects a placeholder email or a short password before touching the database', async () => {
  const { calls, pool } = fakePool();
  await assert.rejects(resetAdmin(pool, { ...config, bootstrapAdminEmail: 'email-admin-anda' }), /alamat email/);
  await assert.rejects(resetAdmin(pool, { ...config, bootstrapAdminPassword: 'pendek' }), /minimal 12 karakter/);
  assert.equal(calls.length, 0);
});
