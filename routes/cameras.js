const crypto = require('node:crypto');
const { audit, inTransaction } = require('../lib/audit');
const { HttpError, readJson, sendJson } = require('../lib/http');
const { isDown } = require('../lib/monitor');
const { encryptRtsp } = require('../lib/rtsp-secrets');
const { normalizeCameraInput, parseRtspUrl } = require('../lib/validate');

const CAMERA_COLUMNS = `c.id, c.camera_code, c.name, c.area, c.ip_address::text, c.map_x, c.map_y, c.details, c.updated_at,
  EXISTS (SELECT 1 FROM camera_streams s WHERE s.camera_id = c.id) AS has_stream`;

function cameraResponse(row) {
  const details = row.details || {};
  const lastPing = details.lastPing || null;
  const pingDown = isDown(lastPing);
  const manualStatus = details.status || 'normal';
  return {
    id: row.camera_code,
    name: row.name,
    area: row.area,
    ip: String(row.ip_address || '').replace(/\/32$/, ''),
    x: Number(row.map_x ?? 50),
    y: Number(row.map_y ?? 50),
    location: details.location || '',
    brand: details.brand || '',
    model: details.model || '',
    serial: details.serial || '',
    color: details.color || '',
    shape: details.shape || 'Dome',
    installed: details.installed || '',
    notes: details.notes || '',
    nvr: details.nvr || '',
    floor: details.floor || 'gf',
    angle: Number(details.angle) || 0,
    fov: Number(details.fov) || 90,
    range: Number(details.range) || 1.5,
    status: pingDown ? 'offline' : manualStatus,
    manualStatus,
    statusSource: pingDown ? 'ping' : 'manual',
    lastPing,
    hasStream: Boolean(row.has_stream),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function fetchCamera(db, code) {
  return (await db.query(`SELECT ${CAMERA_COLUMNS} FROM cameras c WHERE c.camera_code = $1`, [code])).rows[0] || null;
}

function decodeCode(raw) {
  let code = '';
  try { code = decodeURIComponent(raw).trim().toUpperCase(); } catch { code = ''; }
  if (!code) throw new HttpError(400, 'invalid_camera', 'Kode CCTV tidak valid.');
  return code;
}

function readStreamUrl(data, key) {
  if (!Object.prototype.hasOwnProperty.call(data, 'streamUrl')) return undefined;
  const value = typeof data.streamUrl === 'string' ? data.streamUrl.trim() : '';
  if (value && (!key || !parseRtspUrl(value))) throw new HttpError(400, 'invalid_rtsp_url', 'URL RTSP harus memakai alamat IPv4 jaringan lokal.');
  return value;
}

function describeChanges(before, after) {
  const changes = [];
  if (before.map_x !== undefined && (Number(before.map_x) !== after.x || Number(before.map_y) !== after.y)) changes.push('posisi');
  if ((before.details?.angle ?? 0) !== after.details.angle) changes.push(`arah ${after.details.angle}°`);
  if ((before.details?.fov ?? null) !== after.details.fov || (before.details?.range ?? null) !== after.details.range) changes.push('cakupan');
  if ((before.details?.status ?? 'normal') !== after.details.status) changes.push(`status ${after.details.status}`);
  return changes;
}

async function list({ response, deps }) {
  const result = await deps.pool.query(`SELECT ${CAMERA_COLUMNS} FROM cameras c ORDER BY c.camera_code`);
  return sendJson(response, 200, result.rows.map(cameraResponse));
}

async function create({ request, response, user, deps }) {
  const data = await readJson(request, 16 * 1024);
  const input = normalizeCameraInput(data);
  const streamUrl = readStreamUrl(data, deps.rtspEncryptionKey);
  try {
    const row = await inTransaction(deps.pool, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        'INSERT INTO cameras (id, camera_code, name, area, ip_address, map_x, map_y, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, input.code, input.name, input.area, input.ip, input.x, input.y, JSON.stringify(input.details)],
      );
      if (streamUrl) await client.query('INSERT INTO camera_streams (camera_id, encrypted_rtsp) VALUES ($1, $2)', [id, encryptRtsp(streamUrl, deps.rtspEncryptionKey)]);
      await audit(client, { actorId: user.id, action: 'Menambah perangkat', subjectType: 'camera', subjectId: id, cameraCode: input.code, text: `${input.code} · ${input.details.location || input.area}` });
      return fetchCamera(client, input.code);
    });
    deps.hub.broadcast('cameras', { reason: 'create', code: input.code });
    deps.hub.broadcast('history', {});
    return sendJson(response, 201, cameraResponse(row));
  } catch (error) {
    if (error.code === '23505') throw new HttpError(409, 'duplicate_camera', 'ID CCTV sudah digunakan.');
    throw error;
  }
}

async function update({ request, response, params, user, deps }) {
  const code = decodeCode(params[0]);
  const data = await readJson(request, 16 * 1024);
  const current = (await deps.pool.query('SELECT id, camera_code, name, area, ip_address::text, map_x, map_y, details FROM cameras WHERE camera_code = $1', [code])).rows[0];
  if (!current) throw new HttpError(404, 'camera_not_found', 'CCTV tidak ditemukan.');
  const input = normalizeCameraInput(data, current);
  const streamUrl = readStreamUrl(data, deps.rtspEncryptionKey);
  const clearStream = data.clearStream === true;
  if (input.ip !== (current.ip_address ? String(current.ip_address).replace(/\/32$/, '') : null)) delete input.details.lastPing;
  const changes = describeChanges(current, input);
  const row = await inTransaction(deps.pool, async (client) => {
    await client.query(
      'UPDATE cameras SET name = $1, area = $2, ip_address = $3, map_x = $4, map_y = $5, details = $6, updated_at = now() WHERE id = $7',
      [input.name, input.area, input.ip, input.x, input.y, JSON.stringify(input.details), current.id],
    );
    if (clearStream) await client.query('DELETE FROM camera_streams WHERE camera_id = $1', [current.id]);
    else if (streamUrl) {
      await client.query(
        'INSERT INTO camera_streams (camera_id, encrypted_rtsp) VALUES ($1, $2) ON CONFLICT (camera_id) DO UPDATE SET encrypted_rtsp = EXCLUDED.encrypted_rtsp, updated_at = now()',
        [current.id, encryptRtsp(streamUrl, deps.rtspEncryptionKey)],
      );
    }
    const extra = [...changes, ...(streamUrl ? ['URL tayangan'] : []), ...(clearStream ? ['hapus URL tayangan'] : [])];
    await audit(client, { actorId: user.id, action: 'Memperbarui perangkat', subjectType: 'camera', subjectId: current.id, cameraCode: code, text: extra.length ? `${code}: ${extra.join(', ')}` : code });
    return fetchCamera(client, code);
  });
  deps.hub.broadcast('cameras', { reason: 'update', code });
  deps.hub.broadcast('history', {});
  return sendJson(response, 200, cameraResponse(row));
}

async function remove({ response, params, user, deps }) {
  const code = decodeCode(params[0]);
  const deleted = await inTransaction(deps.pool, async (client) => {
    const result = await client.query('DELETE FROM cameras WHERE camera_code = $1 RETURNING id, details', [code]);
    if (!result.rowCount) return null;
    await audit(client, { actorId: user.id, action: 'Menghapus perangkat', subjectType: 'camera', subjectId: result.rows[0].id, cameraCode: code, text: `${code} · ${result.rows[0].details?.location || ''}` });
    return result.rows[0];
  });
  if (!deleted) throw new HttpError(404, 'camera_not_found', 'CCTV tidak ditemukan.');
  deps.hub.broadcast('cameras', { reason: 'delete', code });
  deps.hub.broadcast('history', {});
  return sendJson(response, 204);
}

async function ping({ response, params, user, deps }) {
  const code = decodeCode(params[0]);
  const result = await deps.monitor.pingCamera(code);
  if (!result) throw new HttpError(404, 'camera_not_found', 'CCTV tidak ditemukan.');
  if (!result.lastPing) throw new HttpError(400, 'camera_without_ip', 'CCTV ini belum memiliki alamat IP.');
  await audit(deps.pool, { actorId: user.id, action: 'Menguji IP CCTV', subjectType: 'camera', subjectId: result.camera.id, cameraCode: code, text: `${code} · ${result.lastPing.ip} · ${result.lastPing.status === 'online' ? `aktif ${result.lastPing.latencyMs ?? '?'} ms` : 'tidak merespons'}` });
  deps.hub.broadcast('history', {});
  return sendJson(response, 200, result.lastPing);
}

module.exports = { cameraResponse, create, list, ping, remove, update };
