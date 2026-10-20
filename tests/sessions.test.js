const assert = require('node:assert/strict');
const test = require('node:test');

const { createSession, getSessionUser, pruneExpiredSessions } = require('../lib/sessions');

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
  assert.match(calls[0], /expires_at > now\(\)/);
  assert.match(calls[0], /users\.is_active/);
});

test('session lookup no longer deletes rows on every request; pruning is explicit', async () => {
  const calls = [];
  const pool = { query: async (sql) => { calls.push(sql); return { rows: [], rowCount: 3 }; } };
  await getSessionUser(pool, 'valid-session-token-that-is-long-enough');
  assert.equal(calls.some((sql) => sql.startsWith('DELETE')), false);
  assert.equal(await pruneExpiredSessions(pool), 3);
  assert.ok(calls.at(-1).startsWith('DELETE FROM sessions WHERE expires_at <= now()'));
});
