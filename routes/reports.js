const crypto = require('node:crypto');
const { audit, inTransaction } = require('../lib/audit');
const { HttpError, readJson, sendJson } = require('../lib/http');

const STATUSES = ['open', 'progress', 'resolved'];
const PRIORITIES = ['normal', 'high', 'critical'];
const ISSUES = ['Perangkat offline', 'Gambar tidak jelas', 'Arah kamera berubah', 'Koneksi tidak stabil', 'Lainnya'];
const STATUS_LABEL = { open: 'Baru', progress: 'Dikerjakan', resolved: 'Selesai' };

function reportResponse(row) {
  return {
    id: row.report_code,
    cameraId: row.camera_code,
    issue: row.title,
    note: row.details,
    priority: row.priority,
    status: row.status,
    reporter: row.reporter_name ? `${row.reporter_name}${row.reporter_division ? ` / ${row.reporter_division}` : ''}` : 'Pengguna dihapus',
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
  };
}

const SELECT_REPORTS = `SELECT r.report_code, r.camera_code, r.title, r.details, r.priority, r.status, r.created_at, r.updated_at, r.resolved_at,
  COALESCE(NULLIF(u.display_name, ''), split_part(u.email, '@', 1)) AS reporter_name, u.division AS reporter_division
  FROM reports r LEFT JOIN users u ON u.id = r.created_by`;

async function list({ response, url, deps }) {
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 300));
  const result = await deps.pool.query(`${SELECT_REPORTS} WHERE r.report_code IS NOT NULL ORDER BY r.created_at DESC LIMIT $1`, [limit]);
  return sendJson(response, 200, result.rows.map(reportResponse));
}

async function create({ request, response, user, deps }) {
  const data = await readJson(request, 4 * 1024);
  const cameraCode = typeof data.cameraCode === 'string' ? data.cameraCode.trim().toUpperCase() : '';
  const issue = ISSUES.includes(data.issue) ? data.issue : null;
  const priority = PRIORITIES.includes(data.priority) ? data.priority : null;
  const note = typeof data.note === 'string' ? data.note.trim() : '';
  if (!cameraCode || !issue || !priority) throw new HttpError(400, 'invalid_report', 'Pilih CCTV, jenis masalah, dan prioritas.');
  if (!note || note.length > 1000) throw new HttpError(400, 'invalid_report', 'Catatan wajib diisi, maksimal 1000 karakter.');

  const code = await inTransaction(deps.pool, async (client) => {
    const camera = (await client.query('SELECT id, details FROM cameras WHERE camera_code = $1 FOR UPDATE', [cameraCode])).rows[0];
    if (!camera) throw new HttpError(404, 'camera_not_found', 'CCTV tidak ditemukan.');
    await client.query('LOCK TABLE reports IN SHARE ROW EXCLUSIVE MODE');
    const year = new Date().getFullYear();
    const prefix = `RPT-${year}-`;
    const last = (await client.query("SELECT max(substring(report_code from '(\\d+)$')::int) AS seq FROM reports WHERE report_code LIKE $1", [`${prefix}%`])).rows[0];
    const reportCode = `${prefix}${String((Number(last?.seq) || 0) + 1).padStart(3, '0')}`;
    await client.query(
      'INSERT INTO reports (id, camera_id, created_by, title, details, status, report_code, priority, camera_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [crypto.randomUUID(), camera.id, user.id, issue, note, 'open', reportCode, priority, cameraCode],
    );
    const status = issue === 'Perangkat offline' ? 'offline' : 'warning';
    if ((camera.details?.status || 'normal') !== 'offline') {
      await client.query("UPDATE cameras SET details = jsonb_set(details, '{status}', to_jsonb($1::text)), updated_at = now() WHERE id = $2", [status, camera.id]);
    }
    await audit(client, { actorId: user.id, action: 'Membuat laporan', subjectType: 'report', subjectId: camera.id, cameraCode, text: `${reportCode} · ${cameraCode} · ${issue}` });
    return reportCode;
  });
  const row = (await deps.pool.query(`${SELECT_REPORTS} WHERE r.report_code = $1`, [code])).rows[0];
  for (const type of ['reports', 'cameras', 'history']) deps.hub.broadcast(type, { reason: 'report', code });
  return sendJson(response, 201, reportResponse(row));
}

async function update({ request, response, params, user, deps }) {
  let code = '';
  try { code = decodeURIComponent(params[0]).trim().toUpperCase(); } catch { code = ''; }
  const data = await readJson(request, 1024);
  if (!STATUSES.includes(data.status)) throw new HttpError(400, 'invalid_report', 'Status laporan tidak dikenal.');
  await inTransaction(deps.pool, async (client) => {
    const report = (await client.query('SELECT id, camera_id, camera_code, status FROM reports WHERE report_code = $1 FOR UPDATE', [code])).rows[0];
    if (!report) throw new HttpError(404, 'report_not_found', 'Laporan tidak ditemukan.');
    if (report.status === data.status) return;
    await client.query(
      'UPDATE reports SET status = $1, updated_at = now(), resolved_at = CASE WHEN $1 = \'resolved\' THEN now() ELSE NULL END WHERE id = $2',
      [data.status, report.id],
    );
    if (data.status === 'resolved' && report.camera_id) {
      const active = (await client.query("SELECT count(*)::int AS n FROM reports WHERE camera_id = $1 AND status <> 'resolved' AND id <> $2", [report.camera_id, report.id])).rows[0].n;
      if (!active) await client.query("UPDATE cameras SET details = jsonb_set(details, '{status}', '\"normal\"'), updated_at = now() WHERE id = $1", [report.camera_id]);
    }
    const action = { open: 'Membuka ulang laporan', progress: 'Memulai perbaikan', resolved: 'Menyelesaikan laporan' }[data.status];
    await audit(client, { actorId: user.id, action, subjectType: 'report', subjectId: report.camera_id, cameraCode: report.camera_code, text: `${code} · ${report.camera_code} → ${STATUS_LABEL[data.status]}` });
  });
  const row = (await deps.pool.query(`${SELECT_REPORTS} WHERE r.report_code = $1`, [code])).rows[0];
  for (const type of ['reports', 'cameras', 'history']) deps.hub.broadcast(type, { reason: 'report', code });
  return sendJson(response, 200, reportResponse(row));
}

module.exports = { ISSUES, create, list, update };
