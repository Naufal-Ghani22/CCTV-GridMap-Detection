// Background network monitor: pings every camera and NVR on a fixed interval,
// stores the latest result per camera and records online/offline transitions.
const crypto = require('node:crypto');

const FAIL_THRESHOLD = 2;
const MIN_INTERVAL_SEC = 15;
const MAX_INTERVAL_SEC = 3600;

function isDown(lastPing) {
  return Boolean(lastPing) && Number(lastPing.failures) >= FAIL_THRESHOLD;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function createMonitor({
  pool,
  ping,
  hub = null,
  logError = console.error,
  intervalSec = 60,
  concurrency = 8,
  now = () => new Date(),
} = {}) {
  const state = {
    enabled: false,
    running: false,
    intervalSec: clampInterval(intervalSec),
    lastRunAt: null,
    lastDurationMs: null,
    lastError: null,
    nvrs: [],
  };
  let timer = null;

  function clampInterval(value) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return 60;
    return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, parsed));
  }

  async function safePing(ip) {
    try {
      const result = await ping(ip);
      return result?.status === 'online'
        ? { status: 'online', latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null }
        : { status: 'offline', latencyMs: null };
    } catch (error) {
      logError('Ping monitor gagal:', error.message);
      return { status: 'offline', latencyMs: null };
    }
  }

  async function recordCamera(camera, result) {
    const previous = camera.details?.lastPing || null;
    const failures = result.status === 'online' ? 0 : (Number(previous?.failures) || 0) + 1;
    const lastPing = { status: result.status, latencyMs: result.latencyMs, checkedAt: now().toISOString(), failures, ip: camera.ip };
    await pool.query("UPDATE cameras SET details = jsonb_set(details, '{lastPing}', $1::jsonb) WHERE id = $2", [JSON.stringify(lastPing), camera.id]);
    const wasDown = isDown(previous);
    const nowDown = isDown(lastPing);
    if (wasDown !== nowDown) {
      const text = nowDown ? `${camera.code} tidak merespons ping (${camera.ip})` : `${camera.code} kembali merespons ping`;
      await pool.query(
        'INSERT INTO activity_history (id, actor_id, action, subject_type, subject_id, details) VALUES ($1, NULL, $2, $3, $4, $5)',
        [crypto.randomUUID(), nowDown ? 'Perangkat offline' : 'Perangkat online', 'camera', camera.id, JSON.stringify({ cameraCode: camera.code, text })],
      );
      return { code: camera.code, down: nowDown };
    }
    return null;
  }

  async function loadNvrs() {
    const result = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'nvrs'");
    const list = result.rows[0]?.setting_value;
    return Array.isArray(list) ? list : [];
  }

  async function runOnce() {
    if (state.running) return { skipped: true };
    state.running = true;
    const startedAt = Date.now();
    const transitions = [];
    try {
      const cameras = (await pool.query('SELECT id, camera_code, ip_address::text AS ip, details FROM cameras WHERE ip_address IS NOT NULL')).rows
        .map((row) => ({ id: row.id, code: row.camera_code, ip: String(row.ip).replace(/\/32$/, ''), details: row.details || {} }));
      const nvrs = await loadNvrs();
      const targets = [
        ...cameras.map((camera) => ({ kind: 'camera', ip: camera.ip, camera })),
        ...nvrs.filter((nvr) => nvr && nvr.ip).map((nvr) => ({ kind: 'nvr', ip: nvr.ip, nvr })),
      ];
      const results = await mapLimit(targets, concurrency, async (target) => ({ target, result: await safePing(target.ip) }));
      const nvrState = [];
      for (const { target, result } of results) {
        if (target.kind === 'camera') {
          const change = await recordCamera(target.camera, result);
          if (change) transitions.push(change);
        } else {
          nvrState.push({ id: target.nvr.id, name: target.nvr.name, ip: target.nvr.ip, ...result, checkedAt: now().toISOString() });
        }
      }
      state.nvrs = nvrState;
      state.lastError = null;
      return { cameras: cameras.length, nvrs: nvrState.length, transitions };
    } catch (error) {
      state.lastError = error.message;
      logError('Monitor jaringan gagal:', error.message);
      return { error: error.message, transitions };
    } finally {
      state.running = false;
      state.lastRunAt = now().toISOString();
      state.lastDurationMs = Date.now() - startedAt;
      hub?.broadcast('monitor', snapshot());
      hub?.broadcast('cameras', { reason: 'monitor', transitions });
      if (transitions.length) hub?.broadcast('history', {});
    }
  }

  async function pingCamera(cameraCode) {
    const row = (await pool.query('SELECT id, camera_code, ip_address::text AS ip, details FROM cameras WHERE camera_code = $1', [cameraCode])).rows[0];
    if (!row) return null;
    if (!row.ip) return { camera: row, lastPing: null };
    const camera = { id: row.id, code: row.camera_code, ip: String(row.ip).replace(/\/32$/, ''), details: row.details || {} };
    const result = await safePing(camera.ip);
    const change = await recordCamera(camera, result);
    const updated = (await pool.query('SELECT details FROM cameras WHERE id = $1', [camera.id])).rows[0];
    hub?.broadcast('cameras', { reason: 'ping', transitions: change ? [change] : [] });
    if (change) hub?.broadcast('history', {});
    return { camera: row, lastPing: updated?.details?.lastPing || null };
  }

  function schedule() {
    clearTimeout(timer);
    if (!state.enabled) return;
    timer = setTimeout(async () => {
      await runOnce();
      schedule();
    }, state.intervalSec * 1000);
    timer.unref?.();
  }

  function snapshot() {
    return {
      enabled: state.enabled,
      running: state.running,
      intervalSec: state.intervalSec,
      lastRunAt: state.lastRunAt,
      lastDurationMs: state.lastDurationMs,
      lastError: state.lastError,
      failThreshold: FAIL_THRESHOLD,
      nvrs: state.nvrs,
    };
  }

  return {
    start({ immediate = true } = {}) {
      state.enabled = true;
      if (immediate) runOnce().finally(schedule);
      else schedule();
    },
    stop() {
      state.enabled = false;
      clearTimeout(timer);
    },
    setInterval(seconds) {
      state.intervalSec = clampInterval(seconds);
      schedule();
      return state.intervalSec;
    },
    runOnce,
    pingCamera,
    snapshot,
  };
}

module.exports = { FAIL_THRESHOLD, MAX_INTERVAL_SEC, MIN_INTERVAL_SEC, createMonitor, isDown, mapLimit };
