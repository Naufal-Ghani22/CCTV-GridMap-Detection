const assert = require('node:assert/strict');
const test = require('node:test');
const { FAIL_THRESHOLD, createMonitor, isDown, mapLimit } = require('../lib/monitor');
const { createRateLimiter } = require('../lib/rate-limit');
const { pingCommand } = require('../lib/media');

function monitorPool(cameras, nvrs = []) {
  const updates = [];
  const history = [];
  return {
    updates,
    history,
    async query(sql, values) {
      if (sql.startsWith('SELECT id, camera_code, ip_address::text AS ip, details FROM cameras WHERE ip_address')) return { rows: cameras };
      if (sql.includes("setting_key = 'nvrs'")) return { rows: nvrs.length ? [{ setting_value: nvrs }] : [] };
      if (sql.startsWith('UPDATE cameras SET details = jsonb_set')) {
        const camera = cameras.find((item) => item.id === values[1]);
        camera.details = { ...camera.details, lastPing: JSON.parse(values[0]) };
        updates.push(values);
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO activity_history')) { history.push(values); return { rows: [] }; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('mapLimit never runs more than the limit at once', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
});

test('a camera is marked down only after consecutive failed pings and recovers on success', async () => {
  const cameras = [{ id: 'a', camera_code: 'CCTV-A', ip: '192.168.1.10', details: {} }];
  let online = false;
  const events = [];
  const pool = monitorPool(cameras, [{ id: 'nvr1', name: 'NVR Utama', ip: '192.168.1.2' }]);
  const monitor = createMonitor({ pool, ping: async (ip) => (ip === '192.168.1.2' || online ? { status: 'online', latencyMs: 3 } : { status: 'offline' }), hub: { broadcast: (type) => events.push(type) }, logError: () => {} });

  await monitor.runOnce();
  assert.equal(isDown(cameras[0].details.lastPing), false, 'one miss is tolerated');
  assert.equal(pool.history.length, 0);

  const second = await monitor.runOnce();
  assert.equal(cameras[0].details.lastPing.failures, FAIL_THRESHOLD);
  assert.equal(isDown(cameras[0].details.lastPing), true);
  assert.deepEqual(second.transitions, [{ code: 'CCTV-A', down: true }]);
  assert.equal(pool.history.at(-1)[1], 'Perangkat offline');

  online = true;
  const third = await monitor.runOnce();
  assert.deepEqual(third.transitions, [{ code: 'CCTV-A', down: false }]);
  assert.equal(cameras[0].details.lastPing.latencyMs, 3);
  assert.equal(monitor.snapshot().nvrs[0].status, 'online');
  assert.ok(events.includes('monitor') && events.includes('cameras'));
});

test('overlapping runs are skipped and the interval is clamped', async () => {
  const pool = monitorPool([{ id: 'a', camera_code: 'CCTV-A', ip: '192.168.1.10', details: {} }]);
  let release;
  const monitor = createMonitor({ pool, ping: () => new Promise((resolve) => { release = () => resolve({ status: 'online', latencyMs: 1 }); }), logError: () => {} });
  const first = monitor.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await monitor.runOnce(), { skipped: true });
  release();
  await first;
  assert.equal(monitor.setInterval(1), 15);
  assert.equal(monitor.setInterval(99999), 3600);
});

test('login limiter blocks after the maximum and resets', () => {
  let time = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 60000, now: () => time });
  assert.equal(limiter.hit('k').allowed, true);
  assert.equal(limiter.hit('k').allowed, true);
  const blocked = limiter.hit('k');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, 60);
  limiter.reset('k');
  assert.equal(limiter.hit('k').allowed, true);
  time = 61000;
  limiter.hit('other');
  limiter.prune();
  assert.equal(limiter.size(), 1);
  limiter.stop();
});

test('ping command adapts to the operating system', () => {
  assert.deepEqual(pingCommand('192.168.1.1', 'win32'), ['ping.exe', ['-n', '1', '-w', '1500', '192.168.1.1']]);
  assert.deepEqual(pingCommand('192.168.1.1', 'linux'), ['ping', ['-c', '1', '-W', '2', '192.168.1.1']]);
});
