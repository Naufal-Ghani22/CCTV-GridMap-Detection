const { audit } = require('../lib/audit');
const { HttpError, readJson, sendJson } = require('../lib/http');
const { decryptRtsp } = require('../lib/rtsp-secrets');
const { isPrivateIpv4, isValidIpv4, parseRtspUrl } = require('../lib/validate');

const MAX_CONCURRENT_PINGS = 8;
let activePings = 0;

async function ping({ request, response, deps }) {
  const data = await readJson(request);
  if (!isValidIpv4(data.ip) || !isPrivateIpv4(data.ip)) {
    throw new HttpError(400, 'invalid_ip', 'Hanya alamat IPv4 jaringan lokal yang dapat di-ping, misalnya 192.168.1.64.');
  }
  if (activePings >= MAX_CONCURRENT_PINGS) throw new HttpError(429, 'too_many_pings', 'Terlalu banyak ping berjalan. Coba lagi sebentar.');
  activePings += 1;
  try {
    const result = await deps.ping(data.ip);
    if (!result || !['online', 'offline'].includes(result.status)) throw new Error('Invalid ping result');
    return sendJson(response, 200, {
      status: result.status,
      ip: data.ip,
      latencyMs: result.status === 'online' ? result.latencyMs : null,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    deps.logError('Ping gagal:', error.message);
    throw new HttpError(500, 'ping_failed', 'Layanan ping gagal. Periksa terminal server lalu coba lagi.');
  } finally {
    activePings -= 1;
  }
}

async function createStream({ request, response, user, deps }) {
  const data = await readJson(request);
  const cameraCode = typeof data.cameraCode === 'string' ? data.cameraCode.trim().toUpperCase() : '';
  if (!cameraCode) throw new HttpError(400, 'invalid_camera', 'Pilih CCTV yang ingin ditayangkan.');
  const row = (await deps.pool.query(
    'SELECT c.id, s.encrypted_rtsp FROM cameras c LEFT JOIN camera_streams s ON s.camera_id = c.id WHERE c.camera_code = $1',
    [cameraCode],
  )).rows[0];
  if (!row) throw new HttpError(404, 'camera_not_found', 'CCTV tidak ditemukan.');
  if (!row.encrypted_rtsp || !deps.rtspEncryptionKey) throw new HttpError(404, 'stream_not_configured', 'URL tayangan CCTV ini belum diatur.');
  let url;
  try {
    url = decryptRtsp(row.encrypted_rtsp, deps.rtspEncryptionKey);
  } catch (error) {
    deps.logError('RTSP tersimpan tidak dapat dibaca:', error.message);
    throw new HttpError(500, 'stream_secret_invalid', 'URL tayangan tersimpan rusak. Simpan ulang URL RTSP kamera ini.');
  }
  if (!parseRtspUrl(url)) throw new HttpError(400, 'invalid_rtsp_url', 'URL RTSP tersimpan bukan alamat jaringan lokal.');
  if (!await deps.streamAvailable()) throw new HttpError(503, 'stream_bridge_unavailable', 'Komponen tayangan RTSP (FFmpeg) belum tersedia di server.');
  const token = deps.streams.create(user, url, cameraCode);
  await audit(deps.pool, { actorId: user.id, action: 'Membuka tayangan', subjectType: 'camera', subjectId: row.id, cameraCode, text: cameraCode }).catch(() => {});
  deps.hub.broadcast('history', {});
  return sendJson(response, 201, { playbackUrl: `/api/streams/${token}` });
}

function stream({ request, response, params, user, deps }) {
  return deps.streams.handle(request, response, params[0], user);
}

// Lets the View wall size itself to the server's limits instead of pushing out its own tiles.
async function streamInfo({ response, user, deps }) {
  return sendJson(response, 200, {
    ...deps.streams.limits(),
    active: deps.streams.count(),
    mine: deps.streams.countFor(user.id),
    available: await deps.streamAvailable(),
  });
}

async function monitorStatus({ response, deps }) {
  return sendJson(response, 200, deps.monitor.snapshot());
}

async function monitorRun({ response, user, deps }) {
  const result = await deps.monitor.runOnce();
  if (result.skipped) throw new HttpError(409, 'monitor_busy', 'Pemeriksaan jaringan sedang berjalan.');
  await audit(deps.pool, { actorId: user.id, action: 'Memeriksa seluruh jaringan', subjectType: 'setting', text: `${result.cameras ?? 0} CCTV · ${result.nvrs ?? 0} NVR` }).catch(() => {});
  deps.hub.broadcast('history', {});
  return sendJson(response, 200, deps.monitor.snapshot());
}

function events({ request, response, user, deps }) {
  deps.hub.connect(request, response, user);
}

module.exports = { createStream, events, monitorRun, monitorStatus, ping, stream, streamInfo };
