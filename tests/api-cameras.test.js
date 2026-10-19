const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const { loadEnvironment } = require('../config');
const { createPool } = require('../db/client');
const { createServer } = require('../server');

const config = loadEnvironment();
const pool = createPool(config.databaseUrl);
let server;
let base;
let cookie;

before(async () => {
  server = createServer({ pool, rtspEncryptionKey: config.rtspEncryptionKey, logError: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.bootstrapAdminEmail, password: config.bootstrapAdminPassword }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie');
});

after(async () => {
  await pool.query("DELETE FROM activity_history WHERE subject_type = 'camera' AND details->>'cameraCode' = 'TEST-CAMERA-DB'");
  await pool.query("DELETE FROM cameras WHERE camera_code = 'TEST-CAMERA-DB'");
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('an administrator can add a camera without exposing its RTSP URL', async () => {
  const response = await fetch(`${base}/api/cameras`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: 'TEST-CAMERA-DB', name: 'Kamera pengujian', area: 'Boarding', ip: '192.168.1.64',
      location: 'Lab', status: 'normal', x: 50, y: 50, angle: 0,
      streamUrl: 'rtsp://viewer:password@192.168.1.64/live',
    }),
  });
  const camera = await response.json();
  assert.equal(response.status, 201);
  assert.equal(camera.id, 'TEST-CAMERA-DB');
  assert.equal('streamUrl' in camera, false);

  const list = await fetch(`${base}/api/cameras`, { headers: { Cookie: cookie } });
  const cameras = await list.json();
  const saved = cameras.find((item) => item.id === 'TEST-CAMERA-DB');
  assert.equal(list.status, 200);
  assert.equal(saved.ip, '192.168.1.64');
  assert.equal('streamUrl' in saved, false);
});

test('an administrator can move a plotted camera and the new position persists', async () => {
  const response = await fetch(`${base}/api/cameras/TEST-CAMERA-DB`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ x: 72.5, y: 18.3, angle: 90 }),
  });
  const updated = await response.json();
  assert.equal(response.status, 200);
  assert.equal(updated.x, 72.5);
  assert.equal(updated.y, 18.3);
  assert.equal(updated.angle, 90);

  const list = await fetch(`${base}/api/cameras`, { headers: { Cookie: cookie } });
  const saved = (await list.json()).find((item) => item.id === 'TEST-CAMERA-DB');
  assert.equal(saved.x, 72.5);
  assert.equal(saved.y, 18.3);
  assert.equal(saved.ip, '192.168.1.64', 'a partial update must not wipe other fields');
});

test('a partial update rejects an invalid IP without touching the row', async () => {
  const response = await fetch(`${base}/api/cameras/TEST-CAMERA-DB`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ip: '999.1.1.1' }),
  });
  assert.equal(response.status, 400);
});

test('updating or deleting a missing camera returns 404', async () => {
  const patch = await fetch(`${base}/api/cameras/NO-SUCH-CAMERA`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ x: 10 }),
  });
  assert.equal(patch.status, 404);
  const del = await fetch(`${base}/api/cameras/NO-SUCH-CAMERA`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(del.status, 404);
});

test('an administrator can delete a camera and it disappears from the inventory', async () => {
  const response = await fetch(`${base}/api/cameras/TEST-CAMERA-DB`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(response.status, 204);
  const list = await fetch(`${base}/api/cameras`, { headers: { Cookie: cookie } });
  const stillThere = (await list.json()).some((item) => item.id === 'TEST-CAMERA-DB');
  assert.equal(stillThere, false);
});
