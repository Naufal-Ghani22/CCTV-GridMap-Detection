const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const AREAS = ['Checkin Keberangkatan', 'Kedatangan', 'Boarding'];

async function openAdmin(browser, url, savedCamera = null) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((camera) => {
    sessionStorage.setItem('cctv-map-session', 'admin@airport.local');
    if (camera) localStorage.setItem('cctv-map-state-v2', JSON.stringify({ cameras: [camera] }));
  }, savedCamera);
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  return { context, page };
}

async function main() {
  const server = process.env.CCTV_LAN_URL ? null : createServer();
  if (server) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = process.env.CCTV_LAN_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    let session = await openAdmin(browser, url);
    try {
      const { page } = session;
      assert.equal(await page.locator('#dashCoverage').innerText(), '3 area dipantau');
      await page.locator('[data-view="devices"]').click();
      const row = page.locator('#deviceTable tr', { hasText: 'CCTV-T1-021' });
      assert.match(await row.innerText(), /Boarding/);
      await row.locator('[data-action="edit"]').click();
      const area = page.locator('#formArea');
      assert.equal(await area.evaluate((element) => element.tagName), 'SELECT');
      assert.deepEqual(await area.locator('option:not([value=""])').allTextContents(), AREAS);
      assert.equal(await area.inputValue(), 'Boarding');
      await area.selectOption('Checkin Keberangkatan');
      await page.locator('#deviceForm button[type="submit"]').click();
      assert.match(await row.innerText(), /Checkin Keberangkatan/);
      await page.reload();
      await page.locator('[data-view="devices"]').click();
      assert.match(await row.innerText(), /Checkin Keberangkatan/);
      await page.locator('#addDeviceList').click();
      assert.equal(await page.locator('#formArea').inputValue(), '');
      assert.deepEqual(await page.locator('#formArea option:not([value=""])').allTextContents(), AREAS);
    } finally {
      await session.context.close();
    }

    const customCamera = {
      id: 'CCTV-CUSTOM-1', area: 'Terminal lama', location: 'Lorong A', brand: 'Demo', model: 'Cam',
      serial: 'SER-1', color: 'Putih', shape: 'Dome', installed: '2024-03-12', ip: '', streamUrl: '',
      angle: 0, status: 'normal', x: 50, y: 50, updated: 'Baru diperbarui',
    };
    session = await openAdmin(browser, url, { ...customCamera, id: 'CCTV-T1-021', area: 'Koridor utama', serial: 'HKV-T1-0021' });
    try {
      const { page } = session;
      await page.locator('[data-view="devices"]').click();
      const row = page.locator('#deviceTable tr', { hasText: 'CCTV-T1-021' });
      assert.match(await row.innerText(), /Boarding/);
      await row.locator('[data-action="edit"]').click();
      assert.equal(await page.locator('#formArea').inputValue(), 'Boarding');
    } finally {
      await session.context.close();
    }

    session = await openAdmin(browser, url, customCamera);
    try {
      const { page } = session;
      await page.locator('[data-view="devices"]').click();
      const row = page.locator('#deviceTable tr', { hasText: customCamera.id });
      assert.match(await row.innerText(), /Terminal lama/);
      await row.locator('[data-action="edit"]').click();
      assert.match(await page.locator('#formArea option:checked').innerText(), /Terminal lama/);
      await page.locator('#formArea').selectOption('Kedatangan');
      await page.locator('#deviceForm button[type="submit"]').click();
      assert.match(await row.innerText(), /Kedatangan/);
    } finally {
      await session.context.close();
    }
  } finally {
    await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
  console.log('PASS: tiga pilihan area, migrasi kamera contoh, dan data kustom aman');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
