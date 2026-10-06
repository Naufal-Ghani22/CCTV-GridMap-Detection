const assert = require('node:assert/strict');
const test = require('node:test');

const { loadEnvironment } = require('../config');
const { createPool } = require('../db/client');

test('local database starts with one administrator and no CCTV, reports, or activity', async () => {
  const pool = createPool(loadEnvironment().databaseUrl);
  try {
    const result = await pool.query(`SELECT
      (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM cameras) AS cameras,
      (SELECT count(*) FROM reports) AS reports,
      (SELECT count(*) FROM activity_history) AS activity_history`);
    assert.deepEqual(result.rows[0], {
      users: '1',
      cameras: '0',
      reports: '0',
      activity_history: '0',
    });
  } finally {
    await pool.end();
  }
});
