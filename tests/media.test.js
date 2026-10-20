const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { createStreamManager } = require('../lib/media');

const USER = { id: '11111111-1111-4111-8111-111111111111' };
const RTSP = 'rtsp://192.168.1.64:554/Streaming/channels/101';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls instead of sleeping a fixed time: the full suite runs files in parallel and timers drift.
async function until(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await wait(20);
  }
  return true;
}

// Stand-in for FFmpeg that keeps streaming until it is killed, like a live camera.
function liveStream() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.stdout.end();
    child.emit('close', null);
  };
  child.stdout.write(Buffer.from('fragment'));
  return child;
}

async function serve(t, manager) {
  const server = http.createServer((request, response) => manager.handle(request, response, request.url.slice(1), USER));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    manager.closeAll();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('an unwatched stream token expires after the TTL', async () => {
  const manager = createStreamManager({ startStream: liveStream, ttlMs: 40 });
  manager.create(USER, RTSP, 'CCTV-T1-021');
  assert.equal(manager.count(), 1);
  assert.ok(await until(() => manager.count() === 0), 'token expired');
});

test('a watched stream outlives the TTL and expires once the viewer leaves', async (t) => {
  const ttlMs = 400;
  const manager = createStreamManager({ startStream: liveStream, ttlMs });
  const base = await serve(t, manager);
  const token = manager.create(USER, RTSP, 'CCTV-T1-021');
  const controller = new AbortController();
  const response = await fetch(`${base}/${token}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  await wait(ttlMs * 2);
  assert.equal(manager.count(), 1, 'a video wall tile keeps playing past the TTL');
  controller.abort();
  assert.ok(await until(() => manager.count() === 0), 'the token expires after the viewer disconnects');
});

test('reports the per-user limit a user can actually reach', () => {
  assert.deepEqual(createStreamManager({ maxTotal: 8, maxPerUser: 4 }).limits(), { maxTotal: 8, maxPerUser: 4 });
  assert.deepEqual(createStreamManager({ maxTotal: 6, maxPerUser: 16 }).limits(), { maxTotal: 6, maxPerUser: 6 });
});

test('counts streams per user', () => {
  const manager = createStreamManager({ startStream: liveStream });
  manager.create(USER, RTSP, 'CCTV-T1-021');
  manager.create(USER, RTSP, 'CCTV-T1-022');
  manager.create({ id: 'someone-else' }, RTSP, 'CCTV-T1-023');
  assert.equal(manager.countFor(USER.id), 2);
  assert.equal(manager.count(), 3);
  manager.closeAll();
});
