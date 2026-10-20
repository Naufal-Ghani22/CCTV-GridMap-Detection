const crypto = require('node:crypto');

// Writes one activity_history row. `db` may be the pool or a transaction client.
async function audit(db, { actorId = null, action, subjectType, subjectId = null, cameraCode, text }) {
  const details = {};
  if (cameraCode) details.cameraCode = cameraCode;
  if (text) details.text = text;
  await db.query(
    'INSERT INTO activity_history (id, actor_id, action, subject_type, subject_id, details) VALUES ($1, $2, $3, $4, $5, $6)',
    [crypto.randomUUID(), actorId, action, subjectType, subjectId, JSON.stringify(details)],
  );
}

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { audit, inTransaction };
