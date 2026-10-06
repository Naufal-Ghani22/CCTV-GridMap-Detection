const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { afterEach, test } = require('node:test');

const { hashPassword } = require('../lib/passwords');
const { createServer } = require('../server');

const servers = [];

async function start(pool) {
  const server = createServer({ pool, logError: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

test('creates an HttpOnly server session when administrator credentials are valid', async () => {
  const passwordHash = await hashPassword('bootstrap-password-123');
  const sessionRows = [];
  const user = { id: crypto.randomUUID(), email: 'admin@airport.local', password_hash: passwordHash, role: 'admin' };
  const pool = {
    query: async (sql, values) => {
      if (sql.startsWith('SELECT id, email, password_hash')) return { rows: values[0] === user.email ? [user] : [] };
      if (sql.startsWith('INSERT INTO sessions')) { sessionRows.push(values); return { rows: [] }; }
      if (sql.startsWith('DELETE FROM sessions')) return { rows: [] };
      if (sql.includes('FROM sessions')) return { rows: [{ id: user.id, email: user.email, role: user.role }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const base = await start(pool);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: 'bootstrap-password-123' }),
  });
  const cookie = login.headers.get('set-cookie');
  assert.equal(login.status, 200);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /bootstrap-password/);
  assert.equal(sessionRows.length, 1);

  const session = await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } });
  assert.deepEqual(await session.json(), { user: { id: user.id, email: user.email, role: 'admin' } });
});

test('rejects invalid credentials without a session cookie', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const base = await start(pool);
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nope@example.test', password: 'wrong-password' }),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
});
