const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('../server');

async function main() {
  let result = { status: 'online', latencyMs: 2 };
  let calls = 0;
  const server = createServer({ logError: () => {}, ping: async () => {
    calls += 1;
    if (result instanceof Error) throw result;
    return result;
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => sessionStorage.setItem('cctv-map-session', 'admin@airport.local'));
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.locator('#mobileMenuToggle').click();
    await page.locator('[data-view="settings"]').click();

    const ip = page.locator('#cameraIp');
    const button = page.locator('#pingCamera');
    const status = page.locator('#cameraPingStatus');
    assert.equal(await ip.inputValue(), '192.168.1.64');
    await button.click();
    await status.getByText('Aktif', { exact: true }).waitFor();
    assert.match(await status.innerText(), /2 ms/);
    assert.match(await status.innerText(), /Terakhir diuji/);
    assert.equal(calls, 1);

    await ip.fill('192.168.1.999');
    await button.click();
    assert.match(await status.innerText(), /IPv4 yang valid/);
    assert.equal(calls, 1);

    result = { status: 'offline', latencyMs: null };
    await ip.fill('192.168.1.65');
    await button.click();
    await status.getByText('Tidak merespons', { exact: true }).waitFor();
    assert.match(await status.innerText(), /Periksa daya CCTV/);
    assert.equal(calls, 2);

    await page.locator('#streamForm button[type="submit"]').click();
    await page.reload();
    await page.locator('#mobileMenuToggle').click();
    await page.locator('[data-view="settings"]').click();
    assert.equal(await ip.inputValue(), '192.168.1.65');
    assert.match(await status.innerText(), /Tidak merespons/);
    await page.locator('#networkCamera').selectOption('CCTV-T1-007');
    assert.match(await status.innerText(), /Belum diuji/);
    await page.locator('#networkCamera').selectOption('CCTV-T1-021');
    assert.match(await status.innerText(), /Tidak merespons/);

    await ip.fill('192.168.1.66');
    await page.locator('#streamForm button[type="submit"]').click();
    assert.match(await status.innerText(), /Masukkan alamat IP/);

    let finishPing;
    result = new Promise((resolve) => { finishPing = resolve; });
    await button.click();
    assert.equal(await button.isDisabled(), true);
    assert.match(await status.innerText(), /Menguji 192.168.1.66/);
    finishPing({ status: 'online', latencyMs: 3 });
    await status.getByText('Aktif', { exact: true }).waitFor();

    result = new Error('ping executable unavailable');
    await button.click();
    await status.getByText('Layanan ping bermasalah', { exact: true }).waitFor();
    assert.match(await status.innerText(), /Periksa terminal server/);

    result = { status: 'online', latencyMs: 4 };
    await button.focus();
    await page.keyboard.press('Enter');
    await status.getByText('Aktif', { exact: true }).waitFor();
    assert.match(await status.innerText(), /4 ms/);

    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 812 });
      const layout = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        overflows: [...document.querySelectorAll('body *')]
          .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 8)
          .map((element) => `${element.tagName.toLowerCase()}#${element.id}.${element.className}`),
      }));
      assert.ok(layout.scrollWidth <= width, `overflow pada ${width}px: ${JSON.stringify(layout)}`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('PASS: alur ping kamera, status, penyimpanan, dan mobile');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
