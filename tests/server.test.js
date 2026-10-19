const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createServer } = require('../server');
const { encryptRtsp } = require('../lib/rtsp-secrets');
const { SESSION_COOKIE, createFakePool } = require('./helpers/fake-pool');

const servers = [];
const KEY = Buffer.alloc(32, 5);
const SECRET_URL = 'rtsp://admin:P%40ssw0rd@192.168.1.64:554/Streaming/channels/101';

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function streamPool(encrypted = encryptRtsp(SECRET_URL, KEY)) {
  return createFakePool({
    handlers: [[/FROM cameras c LEFT JOIN camera_streams/, (sql, values) => ({ rows: values[0] === 'CCTV-T1-021' ? [{ id: 'cam-1', encrypted_rtsp: encrypted }] : [] })]],
  });
}

async function start(ping = async () => ({ status: 'online', latencyMs: 2 }), options = {}) {
  const server = createServer({ ping, logError: () => {}, pool: createFakePool(), rtspEncryptionKey: KEY, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function postStream(base, body, cookie = SESSION_COOKIE) {
  return fetch(`${base}/api/streams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function post(base, body, contentType = 'application/json', cookie = SESSION_COOKIE) {
  return fetch(`${base}/api/ping`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...(cookie ? { Cookie: cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function fakeStream(seen) {
  return (url) => {
    seen.push(url);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 0);
    queueMicrotask(() => {
      child.stdout.end(Buffer.from('fake fragmented mp4'));
      child.emit('close', 0);
    });
    return child;
  };
}

test('returns measured online result for a private IPv4 address', async () => {
  const seen = [];
  const base = await start(async (ip) => {
    seen.push(ip);
    return { status: 'online', latencyMs: 2 };
  });
  const response = await post(base, { ip: '192.168.1.64' });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['192.168.1.64']);
  assert.equal(data.status, 'online');
  assert.equal(data.ip, '192.168.1.64');
  assert.equal(data.latencyMs, 2);
  assert.ok(!Number.isNaN(Date.parse(data.checkedAt)));
});

test('returns offline without inventing latency', async () => {
  const base = await start(async () => ({ status: 'offline', latencyMs: null }));
  const data = await (await post(base, { ip: '192.168.1.65' })).json();
  assert.equal(data.status, 'offline');
  assert.equal(data.latencyMs, null);
});

test('ping and stream endpoints require a session', async () => {
  let calls = 0;
  const base = await start(async () => { calls += 1; return { status: 'online', latencyMs: 1 }; });
  assert.equal((await post(base, { ip: '192.168.1.64' }, 'application/json', null)).status, 401);
  assert.equal((await postStream(base, { cameraCode: 'CCTV-T1-021' }, null)).status, 401);
  assert.equal((await fetch(`${base}/api/cameras`)).status, 401);
  assert.equal((await fetch(`${base}/api/events`)).status, 401);
  assert.equal(calls, 0);
});

test('rejects invalid, public, and command-shaped addresses before ping', async () => {
  let calls = 0;
  const base = await start(async () => { calls += 1; return { status: 'online', latencyMs: 1 }; });
  for (const ip of ['', '192.168.1.999', '192.168.01.64', '192.168.1.64 & whoami', 'http://192.168.1.64', '8.8.8.8:80', '8.8.8.8', '1.1.1.1']) {
    const response = await post(base, { ip });
    assert.equal(response.status, 400, ip);
  }
  assert.equal(calls, 0);
});

test('rejects malformed and oversized request bodies', async () => {
  const base = await start();
  assert.equal((await post(base, '{oops')).status, 400);
  assert.equal((await post(base, { ip: '192.168.1.64' }, 'text/plain')).status, 400);
  assert.equal((await post(base, 'a'.repeat(1100))).status, 413);
});

test('serves app assets with security headers while denying hidden and unlisted files', async () => {
  const base = await start();
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /CCTV Map/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/styles.css`)).status, 200);
  assert.equal((await fetch(`${base}/favicon.svg`)).status, 200);
  assert.equal((await fetch(`${base}/sha256.js`)).status, 404);
  assert.equal((await fetch(`${base}/README.md`)).status, 404);
  assert.equal((await fetch(`${base}/.git/config`)).status, 404);
  assert.equal((await fetch(`${base}/tests/server.test.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/api/ping`)).status, 405);
});

test('serves both floor plans as SVG with wall layers', async () => {
  const base = await start();
  for (const floor of ['ground-floor', 'first-floor']) {
    const response = await fetch(`${base}/maps/${floor}.svg`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/svg\+xml/);
    const svg = await response.text();
    assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    assert.match(svg, /class="fp-solid"/);
    assert.ok(svg.length < 400 * 1024, 'wall-only plans stay light');
  }
  assert.equal((await fetch(`${base}/maps/other.svg`)).status, 404);
});

test('returns a service error when ping cannot start', async () => {
  const base = await start(async () => { throw new Error('missing executable'); });
  const response = await post(base, { ip: '192.168.1.64' });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'ping_failed');
});

test('keeps serving when the database rejects every query', async () => {
  const pool = { query: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); }, connect: async () => { throw new Error('connect ECONNREFUSED'); } };
  const base = await start(undefined, { pool });
  const cameras = await fetch(`${base}/api/cameras`, { headers: { Cookie: SESSION_COOKIE } });
  assert.equal(cameras.status, 503);
  assert.equal((await cameras.json()).error, 'database_unavailable');
  const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: SESSION_COOKIE } });
  assert.equal(logout.status, 503);
  assert.equal((await fetch(base)).status, 200, 'static assets still load');
});

test('creates an opaque playback URL from the stored, encrypted RTSP of a camera', async () => {
  const seen = [];
  const base = await start(undefined, { pool: streamPool(), streamAvailable: async () => true, startStream: fakeStream(seen) });
  const response = await postStream(base, { cameraCode: 'CCTV-T1-021' });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.match(data.playbackUrl, /^\/api\/streams\/[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(data), /admin|ssw0rd|192\.168\.1\.64/);

  const video = await fetch(`${base}${data.playbackUrl}`, { headers: { Cookie: SESSION_COOKIE } });
  assert.equal(video.status, 200);
  assert.match(video.headers.get('content-type'), /^video\/mp4/);
  assert.equal(await video.text(), 'fake fragmented mp4');
  assert.deepEqual(seen, [SECRET_URL]);

  const removed = await fetch(`${base}${data.playbackUrl}`, { method: 'DELETE', headers: { Cookie: SESSION_COOKIE } });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(`${base}${data.playbackUrl}`, { headers: { Cookie: SESSION_COOKIE } })).status, 404);
});

test('a browser can no longer send a raw RTSP URL', async () => {
  const base = await start(undefined, { pool: streamPool(), streamAvailable: async () => true });
  const response = await postStream(base, { url: SECRET_URL });
  assert.equal(response.status, 400);
});

test('reports unknown cameras, missing streams, and a missing RTSP bridge clearly', async () => {
  const base = await start(undefined, { pool: streamPool(), streamAvailable: async () => false });
  assert.equal((await (await postStream(base, { cameraCode: 'NO-SUCH' })).json()).error, 'camera_not_found');
  const unavailable = await postStream(base, { cameraCode: 'CCTV-T1-021' });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, 'stream_bridge_unavailable');

  const noStream = createFakePool({ handlers: [[/LEFT JOIN camera_streams/, { rows: [{ id: 'cam-1', encrypted_rtsp: null }] }]] });
  const other = await start(undefined, { pool: noStream, streamAvailable: async () => true });
  assert.equal((await (await postStream(other, { cameraCode: 'CCTV-T1-021' })).json()).error, 'stream_not_configured');
});

test('limits concurrent stream sessions in total', async () => {
  const base = await start(undefined, { pool: streamPool(), streamAvailable: async () => true, maxStreams: 2 });
  // The same user reuses sessions beyond the per-user limit, so use the total cap here.
  assert.equal((await postStream(base, { cameraCode: 'CCTV-T1-021' })).status, 201);
  assert.equal((await postStream(base, { cameraCode: 'CCTV-T1-021' })).status, 201);
  const third = await postStream(base, { cameraCode: 'CCTV-T1-021' });
  assert.equal(third.status, 429);
  assert.equal((await third.json()).error, 'stream_limit');
});

test('a stream token cannot be used by another user', async () => {
  const pool = streamPool();
  const base = await start(undefined, { pool, streamAvailable: async () => true, startStream: fakeStream([]) });
  const { playbackUrl } = await (await postStream(base, { cameraCode: 'CCTV-T1-021' })).json();
  const otherUser = { id: '22222222-2222-4222-8222-222222222222', email: 'x@airport.local', role: 'operator' };
  const originalQuery = pool.query;
  pool.query = async (sql, values) => (sql.includes('FROM sessions') ? { rows: [otherUser] } : originalQuery(sql, values));
  assert.equal((await fetch(`${base}${playbackUrl}`, { headers: { Cookie: SESSION_COOKIE } })).status, 404);
});

test('operators cannot call administrator endpoints', async () => {
  const base = await start();
  const response = await fetch(`${base}/api/users`, { headers: { Cookie: SESSION_COOKIE } });
  assert.equal(response.status, 403);
  const patch = await fetch(`${base}/api/cameras/CCTV-T1-021`, { method: 'PATCH', headers: { Cookie: SESSION_COOKIE, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(patch.status, 403);
});
