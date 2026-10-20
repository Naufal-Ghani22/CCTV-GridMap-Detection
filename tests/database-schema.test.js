const assert = require('node:assert/strict');
const test = require('node:test');

const { migrate } = require('../db/migrate');
const { bootstrapAdmin } = require('../db/bootstrap');

test('migration creates the empty CCTV, report, activity, and session tables', async () => {
  const queries = [];
  await migrate({ query: async (sql) => { queries.push(sql); } });
  const schema = queries.join('\n');
  for (const table of ['users', 'cameras', 'camera_streams', 'reports', 'activity_history', 'settings', 'sessions']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});

test('bootstrap creates one administrator only when users is empty', async () => {
  const inserts = [];
  const client = {
    query: async (sql, values) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('LOCK TABLE')) return { rows: [] };
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: String(inserts.length) }] };
      if (sql.startsWith('INSERT INTO users')) { inserts.push(values); return { rows: [] }; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release: () => {},
  };
  const pool = { connect: async () => client };
  const config = { bootstrapAdminEmail: 'admin@example.test', bootstrapAdminPassword: 'bootstrap-password-123' };

  assert.equal(await bootstrapAdmin(pool, config), true);
  assert.equal(await bootstrapAdmin(pool, config), false);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][1], 'admin@example.test');
  assert.equal(inserts[0][3], 'admin');
});
