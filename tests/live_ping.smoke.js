const assert = require('node:assert/strict');
const { chromium } = require('playwright');

async function main() {
  const url = process.env.CCTV_LAN_URL || 'http://127.0.0.1:8080';
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => sessionStorage.setItem('cctv-map-session', 'admin@airport.local'));
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.locator('[data-view="settings"]').click();
    await page.locator('#cameraIp').fill('192.168.1.64');
    await page.locator('#pingCamera').click();
    await page.locator('#cameraPingStatus').getByText('Aktif', { exact: true }).waitFor({ timeout: 10000 });
    const detail = await page.locator('#cameraPingDetail').innerText();
    assert.match(detail, /192\.168\.1\.64 merespons dalam \d+ ms/);
    assert.match(detail, /Terakhir diuji/);
    if (process.env.CCTV_SCREENSHOT_PATH) {
      await page.locator('#cameraPingStatus').scrollIntoViewIfNeeded();
      await page.screenshot({ path: process.env.CCTV_SCREENSHOT_PATH, fullPage: true });
    }
    console.log(`PASS: browser LAN -> ${detail}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
