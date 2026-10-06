const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { chromium } = require('playwright');
const { createServer } = require('../server');

async function main() {
  const openedUrls = [];
  const processes = [];
  const server = createServer({
    logError: () => {},
    streamAvailable: async () => true,
    startStream(url) {
      openedUrls.push(url);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        child.stdout.end();
        child.emit('close', 0);
      };
      processes.push(child);
      return child;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => sessionStorage.setItem('cctv-map-session', 'admin@airport.local'));
    await page.goto(base);
    await page.locator('[data-view="settings"]').click();

    const streamUrl = 'rtsp://admin:P@ssw0rd@192.168.1.64:554/Streaming/channels/101';
    const streamInput = page.locator('#cameraStream');
    assert.equal(await streamInput.getAttribute('type'), 'password');
    await streamInput.fill(streamUrl);
    await page.locator('#streamForm button[type="submit"]').click();

    await page.locator('[data-view="devices"]').click();
    const row = page.locator('#deviceTable tr').filter({ hasText: 'CCTV-T1-021' });
    await row.getByRole('button', { name: 'Tayangan' }).click();
    const video = page.locator('#liveVideo');
    await page.waitForFunction(() => document.querySelector('#liveVideo').getAttribute('src')?.startsWith('/api/streams/'));
    const source = await video.getAttribute('src');
    assert.match(source, /^\/api\/streams\/[a-f0-9]{32}$/);
    assert.doesNotMatch(source, /admin|ssw0rd|192\.168\.1\.64/);
    assert.deepEqual(openedUrls, [streamUrl]);

    await page.locator('#liveDialog [data-close="liveDialog"]').click();
    await page.waitForFunction(() => !document.querySelector('#liveVideo').hasAttribute('src'));
    assert.deepEqual(errors, []);
  } finally {
    for (const process of processes) process.kill();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('PASS: URL RTSP disimpan, dijembatani, dan kredensial tidak tampil di URL pemutar');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
