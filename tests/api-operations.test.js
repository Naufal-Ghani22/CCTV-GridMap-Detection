// Integration tests against the local PostgreSQL database from .env.
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const { loadEnvironment } = require('../config');
const { createPool } = require('../db/client');
const { createServer } = require('../server');

const config = loadEnvironment();
const pool = createPool(config.databaseUrl);
const CAMERA = 'TEST-OPS-CAM';
const OPERATOR = 'test-operator@airport.local';
let server;
let base;
let admin;
let pingResult = { status: 'online', latencyMs: 4 };
let savedSettings = [];
const TOUCHED_SETTINGS = ['nvrs', 'areas', 'map:ff'];

async function api(path, { method = 'GET', body, cookie = admin, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null, headers: response.headers };
}

async function login(email, password) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { status: response.status, cookie: response.headers.get('set-cookie') };
}

async function cleanup() {
  await pool.query("DELETE FROM reports WHERE camera_code = $1", [CAMERA]);
  await pool.query("DELETE FROM activity_history WHERE details->>'cameraCode' = $1", [CAMERA]);
  await pool.query('DELETE FROM cameras WHERE camera_code = $1', [CAMERA]);
  await pool.query('DELETE FROM users WHERE email = $1', [OPERATOR]);
}

before(async () => {
  await cleanup();
  // Settings belong to the real installation: snapshot them and restore after the run.
  savedSettings = (await pool.query('SELECT setting_key, setting_value FROM settings WHERE setting_key = ANY($1)', [TOUCHED_SETTINGS])).rows;
  server = createServer({ pool, rtspEncryptionKey: config.rtspEncryptionKey, logError: () => {}, ping: async () => pingResult });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const result = await login(config.bootstrapAdminEmail, config.bootstrapAdminPassword);
  assert.equal(result.status, 200);
  admin = result.cookie;
  const created = await api('/api/cameras', { method: 'POST', body: { id: CAMERA, area: 'Boarding', location: 'Lab', ip: '192.168.77.10', x: 0, y: 40, angle: 90, fov: 70, range: 3 } });
  assert.equal(created.status, 201);
  assert.equal(created.data.x, 0);
  assert.equal(created.data.fov, 70);
});

after(async () => {
  await cleanup();
  await pool.query('DELETE FROM settings WHERE setting_key = ANY($1)', [TOUCHED_SETTINGS]);
  for (const row of savedSettings) await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2)', [row.setting_key, JSON.stringify(row.setting_value)]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('reports are numbered, shared, and drive camera status until resolved', async () => {
  const created = await api('/api/reports', { method: 'POST', body: { cameraCode: CAMERA, issue: 'Gambar tidak jelas', priority: 'high', note: 'Buram di sisi kanan.' } });
  assert.equal(created.status, 201);
  assert.match(created.data.id, /^RPT-\d{4}-\d{3,}$/);
  let camera = (await api('/api/cameras')).data.find((item) => item.id === CAMERA);
  assert.equal(camera.status, 'warning');

  const listed = await api('/api/reports');
  assert.ok(listed.data.some((report) => report.id === created.data.id && report.priority === 'high'));

  assert.equal((await api(`/api/reports/${created.data.id}`, { method: 'PATCH', body: { status: 'progress' } })).data.status, 'progress');
  assert.equal((await api(`/api/reports/${created.data.id}`, { method: 'PATCH', body: { status: 'resolved' } })).data.status, 'resolved');
  camera = (await api('/api/cameras')).data.find((item) => item.id === CAMERA);
  assert.equal(camera.status, 'normal');

  const history = await api('/api/history?limit=50');
  assert.ok(history.data.some((item) => item.action === 'Menyelesaikan laporan' && item.cameraId === CAMERA));
  assert.equal((await api('/api/reports', { method: 'POST', body: { cameraCode: CAMERA, issue: 'Bukan jenis', priority: 'high', note: 'x' } })).status, 400);
});

test('manual camera ping stores the result and two failures mark the camera offline', async () => {
  pingResult = { status: 'online', latencyMs: 4 };
  const online = await api(`/api/cameras/${CAMERA}/ping`, { method: 'POST' });
  assert.equal(online.status, 200);
  assert.equal(online.data.latencyMs, 4);

  pingResult = { status: 'offline', latencyMs: null };
  await api(`/api/cameras/${CAMERA}/ping`, { method: 'POST' });
  await api(`/api/cameras/${CAMERA}/ping`, { method: 'POST' });
  const camera = (await api('/api/cameras')).data.find((item) => item.id === CAMERA);
  assert.equal(camera.status, 'offline');
  assert.equal(camera.statusSource, 'ping');
  assert.equal(camera.manualStatus, 'normal');
  pingResult = { status: 'online', latencyMs: 4 };
});

test('settings store NVR servers and areas, with validation', async () => {
  const saved = await api('/api/settings/nvrs', { method: 'PUT', body: { nvrs: [{ name: 'NVR Terminal', ip: '192.168.77.2', location: 'Ruang server' }] } });
  assert.equal(saved.status, 200);
  assert.equal((await api('/api/settings/nvrs', { method: 'PUT', body: { nvrs: [{ name: 'Publik', ip: '8.8.8.8' }] } })).status, 400);
  assert.equal((await api('/api/settings/areas', { method: 'PUT', body: { areas: ['Boarding', 'Kedatangan', 'Boarding', ' Apron '] } })).data.areas.length, 3);
  const settings = await api('/api/settings');
  assert.equal(settings.data.nvrs[0].name, 'NVR Terminal');
  assert.deepEqual(settings.data.areas, ['Boarding', 'Kedatangan', 'Apron']);
});

test('a custom floor plan replaces the default and unsafe SVG is refused', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path class="fp-wall" d="M0 0h100"/></svg>';
  const put = await api('/api/maps/ff?name=uji.svg', { method: 'PUT', body: svg, headers: { 'Content-Type': 'image/svg+xml' } });
  assert.equal(put.status, 200);
  const served = await fetch(`${base}/api/maps/ff`, { headers: { Cookie: admin } });
  assert.equal(await served.text(), svg);
  const unsafe = await api('/api/maps/ff', { method: 'PUT', body: '<svg viewBox="0 0 1 1" onload="alert(1)"></svg>', headers: { 'Content-Type': 'image/svg+xml' } });
  assert.equal(unsafe.status, 400);
  assert.equal((await api('/api/maps/ff', { method: 'DELETE' })).status, 204);
  assert.match(await (await fetch(`${base}/api/maps/ff`, { headers: { Cookie: admin } })).text(), /fp-line/);
});

test('administrators manage operator accounts; operators get read access only', async () => {
  const created = await api('/api/users', { method: 'POST', body: { email: OPERATOR, name: 'Petugas Uji', division: 'Operasional', role: 'operator', password: 'operator-password-123' } });
  assert.equal(created.status, 201);
  assert.equal((await api('/api/users', { method: 'POST', body: { email: OPERATOR, role: 'operator', password: 'operator-password-123' } })).status, 409);
  assert.equal((await api('/api/users', { method: 'POST', body: { email: 'weak@airport.local', role: 'operator', password: 'short' } })).status, 400);

  const operator = await login(OPERATOR, 'operator-password-123');
  assert.equal(operator.status, 200);
  const session = await api('/api/auth/session', { cookie: operator.cookie });
  assert.equal(session.data.user.name, 'Petugas Uji');
  assert.equal((await api('/api/cameras', { cookie: operator.cookie })).status, 200);
  assert.equal((await api('/api/users', { cookie: operator.cookie })).status, 403);
  assert.equal((await api(`/api/cameras/${CAMERA}`, { method: 'PATCH', body: { angle: 10 }, cookie: operator.cookie })).status, 403);

  const profile = await api('/api/me', { method: 'PATCH', body: { name: 'Petugas Satu', division: 'Keamanan' }, cookie: operator.cookie });
  assert.equal(profile.data.user.name, 'Petugas Satu');

  const disabled = await api(`/api/users/${created.data.id}`, { method: 'PATCH', body: { isActive: false } });
  assert.equal(disabled.data.isActive, false);
  assert.equal((await api('/api/cameras', { cookie: operator.cookie })).status, 401, 'deactivation ends active sessions');
  assert.equal((await login(OPERATOR, 'operator-password-123')).status, 401);

  const me = (await api('/api/auth/session')).data.user;
  assert.equal((await api(`/api/users/${me.id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await api(`/api/users/${created.data.id}`, { method: 'DELETE' })).status, 204);
});

test('login is rate limited per address and email', async () => {
  let last;
  for (let attempt = 0; attempt < 6; attempt += 1) last = await login('nobody@airport.local', 'wrong-password-123');
  assert.equal(last.status, 429);
});
