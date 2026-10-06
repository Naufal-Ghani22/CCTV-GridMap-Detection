const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { createServer } = require('../server');

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function start(ping = async () => ({ status: 'online', latencyMs: 2 }), options = {}) {
  const server = createServer({ ping, logError: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function postStream(base, url) {
  return fetch(`${base}/api/streams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

async function post(base, body, contentType = 'application/json') {
  return fetch(`${base}/api/ping`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('returns measured online result for a canonical IPv4 address', async () => {
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
  const response = await post(base, { ip: '192.168.1.65' });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.status, 'offline');
  assert.equal(data.latencyMs, null);
});

test('rejects invalid and command-shaped addresses before ping', async () => {
  let calls = 0;
  const base = await start(async () => { calls += 1; return { status: 'online', latencyMs: 1 }; });
  for (const ip of ['', '192.168.1.999', '192.168.01.64', '192.168.1.64 & whoami', 'http://192.168.1.64', '8.8.8.8:80']) {
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

test('serves app assets while denying hidden and unlisted files', async () => {
  const base = await start();
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /CCTV Map/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/sha256.js`)).status, 200);
  assert.equal((await fetch(`${base}/styles.css`)).status, 200);
  assert.equal((await fetch(`${base}/README.md`)).status, 404);
  assert.equal((await fetch(`${base}/.git/config`)).status, 404);
  assert.equal((await fetch(`${base}/tests/server.test.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/api/ping`)).status, 405);
});

test('returns a service error when ping cannot start', async () => {
  const base = await start(async () => { throw new Error('missing executable'); });
  const response = await post(base, { ip: '192.168.1.64' });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'ping_failed');
});

test('creates an opaque playback URL for a private RTSP camera', async () => {
  const secretUrl = 'rtsp://admin:P%40ssw0rd@192.168.1.64:554/Streaming/channels/101';
  const base = await start(undefined, { streamAvailable: async () => true });
  const response = await postStream(base, secretUrl);
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.match(data.playbackUrl, /^\/api\/streams\/[a-f0-9]{32}$/);
  assert.doesNotMatch(data.playbackUrl, /admin|ssw0rd|192\.168\.1\.64/);
});

test('rejects non-RTSP, public, malformed, and oversized stream URLs', async () => {
  const base = await start(undefined, { streamAvailable: async () => true });
  for (const url of [
    'http://192.168.1.64/video.mp4',
    'rtsp://admin:secret@8.8.8.8/live',
    'rtsp://not-an-ip/live',
    'rtsp://192.168.1.999/live',
    'rtsp://192.168.1.64/live\nheader: injected',
  ]) {
    const response = await postStream(base, url);
    assert.equal(response.status, 400, url);
  }
  assert.equal((await postStream(base, `rtsp://192.168.1.64/${'a'.repeat(1100)}`)).status, 413);
});

test('reports a clear error when the RTSP bridge is unavailable', async () => {
  const base = await start(undefined, { streamAvailable: async () => false });
  const response = await postStream(base, 'rtsp://192.168.1.64/live');
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.error, 'stream_bridge_unavailable');
});

test('streams browser-compatible MP4 and invalidates a deleted session', async () => {
  const { PassThrough } = require('node:stream');
  const { EventEmitter } = require('node:events');
  const seen = [];
  const base = await start(undefined, {
    streamAvailable: async () => true,
    startStream(url) {
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
    },
  });
  const secretUrl = 'rtsp://admin:P%40ssw0rd@192.168.1.64:554/Streaming/channels/101';
  const created = await postStream(base, secretUrl);
  const { playbackUrl } = await created.json();
  const video = await fetch(`${base}${playbackUrl}`);
  assert.equal(video.status, 200);
  assert.match(video.headers.get('content-type'), /^video\/mp4/);
  assert.equal(await video.text(), 'fake fragmented mp4');
  assert.deepEqual(seen, [secretUrl]);

  const removed = await fetch(`${base}${playbackUrl}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(`${base}${playbackUrl}`)).status, 404);
});
