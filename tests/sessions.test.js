const assert = require('node:assert/strict');
const test = require('node:test');

const { createSession, getSessionUser } = require('../lib/sessions');

test('sessions store only a digest instead of the browser token', async () => {
  const calls = [];
  const pool = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  const session = await createSession(pool, '5b7ea1c1-f23c-4d5d-a0db-09e029fb284a');
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(calls[0].values[0], session.token);
  assert.match(calls[0].values[0], /^[a-f0-9]{64}$/);
});

test('expired sessions do not return a user', async () => {
  const calls = [];
  const pool = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.startsWith('SELECT')) return { rows: [] };
      return { rows: [] };
    },
  };
  assert.equal(await getSessionUser(pool, 'valid-session-token-that-is-long-enough'), null);
  assert.ok(calls[0].startsWith('DELETE FROM sessions'));
});
