// End-to-end UI check in headless Edge against the local PostgreSQL from .env.
// Run: npm run test:e2e   (set E2E_SCREENSHOTS=folder to keep screenshots)
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { after, before, test } = require('node:test');

const { loadEnvironment } = require('../config');
const { createPool } = require('../db/client');
const { hashPassword } = require('../lib/passwords');
const { createSession } = require('../lib/sessions');
const { createServer } = require('../server');
const { findBrowser, launchBrowser } = require('./helpers/edge-cdp');

const config = loadEnvironment();
const pool = createPool(config.databaseUrl);
const EMAIL = 'e2e-admin@airport.local';
const CAMERAS = ['E2E-CAM-1', 'E2E-CAM-2'];
const shots = process.env.E2E_SCREENSHOTS;
let server;
let base;
let page;
let token;

async function cleanup() {
  await pool.query('DELETE FROM reports WHERE camera_code = ANY($1)', [CAMERAS]);
  await pool.query("DELETE FROM activity_history WHERE details->>'cameraCode' = ANY($1)", [CAMERAS]);
  await pool.query('DELETE FROM cameras WHERE camera_code = ANY($1)', [CAMERAS]);
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
}

async function camera(code) {
  const row = (await pool.query('SELECT map_x, map_y, details FROM cameras WHERE camera_code = $1', [code])).rows[0];
  return row && { x: Number(row.map_x), y: Number(row.map_y), ...row.details };
}

before(async () => {
  await cleanup();
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO users (id, email, password_hash, role, display_name, division) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, EMAIL, await hashPassword(crypto.randomBytes(24).toString('hex')), 'admin', 'Uji E2E', 'Teknologi Informasi']);
  ({ token } = await createSession(pool, id));
  for (const [index, code] of CAMERAS.entries()) {
    await pool.query('INSERT INTO cameras (id, camera_code, name, area, map_x, map_y, details) VALUES ($1, $2, $2, $3, $4, $5, $6)',
      [crypto.randomUUID(), code, 'Boarding', 30 + index * 20, 50, JSON.stringify({ location: `Lokasi uji ${index + 1}`, floor: 'gf', angle: 90, fov: 90, range: 2, shape: 'Dome', status: index ? 'warning' : 'normal' })]);
  }
  server = createServer({ pool, rtspEncryptionKey: config.rtspEncryptionKey, logError: () => {}, ping: async () => ({ status: 'online', latencyMs: 1 }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  if (findBrowser()) page = await launchBrowser();
});

after(async () => {
  await page?.close();
  await cleanup();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('login screen renders without script errors', { skip: !findBrowser() && 'Edge/Chrome tidak ditemukan' }, async () => {
  await page.goto(`${base}/`);
  assert.equal(await page.eval("!document.querySelector('#authScreen').classList.contains('hidden')"), true);
  assert.equal(await page.eval("document.querySelector('#loginButton').textContent.trim()"), 'Masuk');
  assert.deepEqual(page.errors, []);
});

test('map shows plotted cameras with direction cones and an issue list', { skip: !findBrowser() && 'Edge/Chrome tidak ditemukan' }, async () => {
  await page.setCookie('cctv_session', token, `${base}/`);
  await page.goto(`${base}/?view=1#map`, 3000);
  await page.waitFor("document.querySelectorAll('.camera-marker').length >= 2");
  for (const code of CAMERAS) {
    assert.equal(await page.eval(`Boolean(document.querySelector('.camera-marker[data-id="${code}"] .camera-fov .wedge'))`), true, code);
  }
  assert.equal(await page.eval(`document.querySelector('.camera-marker[data-id="${CAMERAS[0]}"]').style.getPropertyValue('--dir')`), '90deg');
  assert.match(await page.eval("document.querySelector('#cameraList').textContent"), /PERLU PERHATIAN|Perlu perhatian/i);
  assert.equal(await page.eval("document.querySelector('#syncPill').classList.contains('ok')"), true, 'SSE connected');
  if (shots) await page.screenshot(path.join(shots, 'e2e-map.png'));
  assert.deepEqual(page.errors, []);
});

test('an administrator rotates a camera by dragging the cone tip and it is saved', { skip: !findBrowser() && 'Edge/Chrome tidak ditemukan' }, async () => {
  await page.eval(`document.querySelector('.camera-row[data-id="${CAMERAS[0]}"]').click()`);
  await page.eval("document.querySelector('#editToggle').click()");
  await page.waitFor("document.querySelectorAll('.handle').length === 3");
  const tip = await page.center('.handle.tip');
  const marker = await page.center('.camera-marker.selected .camera');
  // Drag the tip straight below the camera: the camera should face south (180°).
  await page.drag(tip, [marker[0], marker[1] + 140]);
  await page.waitFor("document.querySelector('#saveState').textContent.startsWith('Tersimpan')");
  const saved = await camera(CAMERAS[0]);
  assert.equal(saved.angle, 180);
  assert.ok(saved.range > 2, `range grew (${saved.range})`);
  assert.equal(await page.eval("document.querySelector('#directionName').textContent"), 'Selatan');
  if (shots) await page.screenshot(path.join(shots, 'e2e-rotate.png'));

  await page.eval("document.querySelector('#undoButton').click()");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await camera(CAMERAS[0])).angle, 90, 'undo restores the saved direction');
  assert.deepEqual(page.errors, []);
});

test('cardinal buttons and keyboard shortcuts change direction', { skip: !findBrowser() && 'Edge/Chrome tidak ditemukan' }, async () => {
  await page.eval("document.querySelector('.cardinal-buttons [data-angle=\"270\"]').click()");
  await page.eval("document.body.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }))");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await camera(CAMERAS[0])).angle, 275);
  await page.eval("document.querySelector('#editToggle').click()");
});

test('View shows a video grid whose size can be chosen', { skip: !findBrowser() && 'Edge/Chrome tidak ditemukan' }, async () => {
  await page.eval("localStorage.removeItem('cctv-map-prefs-v1')");
  await page.goto(`${base}/#view`, 3000);
  await page.waitFor("document.querySelectorAll('#wallGrid .wall-tile').length === 4");
  await page.eval("document.querySelector('#wallLayouts [data-layout=\"9\"]').click()");
  await page.waitFor("document.querySelectorAll('#wallGrid .wall-tile').length === 9");
  await page.eval("document.querySelector('#wallLayouts [data-layout=\"custom\"]').click()");
  await page.eval("const cols = document.querySelector('#wallCols'); cols.value = '4'; cols.dispatchEvent(new Event('change'))");
  await page.waitFor("document.querySelectorAll('#wallGrid .wall-tile').length === 12");
  assert.equal(await page.eval("getComputedStyle(document.querySelector('#wallGrid')).gridTemplateColumns.split(' ').length"), 4);
  if (shots) await page.screenshot(path.join(shots, 'e2e-view.png'));
  assert.deepEqual(page.errors, []);
});

test('the standalone View window shows only the grid', { skip: !findBrowser() && 'Edge/Chrome tidak ditemukan' }, async () => {
  await page.goto(`${base}/?display=wall#view`, 3000);
  await page.waitFor("document.documentElement.classList.contains('wall-display') && document.querySelectorAll('#wallGrid .wall-tile').length > 0");
  assert.equal(await page.eval("getComputedStyle(document.querySelector('.rail')).display"), 'none');
  assert.equal(await page.eval("getComputedStyle(document.querySelector('.topbar')).display"), 'none');
  await page.waitFor("document.title.includes('View | CCTV Map')");
  if (shots) await page.screenshot(path.join(shots, 'e2e-view-window.png'));
  assert.deepEqual(page.errors, []);
});
