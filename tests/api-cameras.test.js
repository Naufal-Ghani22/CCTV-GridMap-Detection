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
