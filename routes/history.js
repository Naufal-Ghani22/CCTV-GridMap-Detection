const { sendJson } = require('../lib/http');

async function list({ response, url, deps }) {
  const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 300));
  const result = await deps.pool.query(
    `SELECT h.id, h.action, h.details, h.created_at,
            COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS actor
       FROM activity_history h
       LEFT JOIN users u ON u.id = h.actor_id
      ORDER BY h.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return sendJson(response, 200, result.rows.map((row) => ({
    id: row.id,
    action: row.action,
    detail: row.details?.text || row.details?.cameraCode || '',
    cameraId: row.details?.cameraCode || '',
    actor: row.actor || 'Sistem',
    createdAt: new Date(row.created_at).toISOString(),
  })));
}

module.exports = { list };
