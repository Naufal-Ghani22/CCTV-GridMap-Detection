const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const CAMERA_ID = 'CCTV-T1-021';
const LOCAL_CAMERA_IP = '192.168.1.64';

function startServer() {
  const projectRoot = path.resolve(__dirname, '..');
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
  };
  const server = http.createServer((request, response) => {
    const requestPath = request.url === '/' ? '/index.html' : request.url.split('?')[0];
    const filePath = path.join(projectRoot, requestPath);
    fs.readFile(filePath, (error, contents) => {
      if (error) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
      response.end(contents);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function openInventory(browser, appUrl, savedCamera = null) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const state = savedCamera ? JSON.stringify({ cameras: [savedCamera] }) : null;

  await page.addInitScript(({ savedState }) => {
    sessionStorage.setItem('cctv-map-session', 'admin@airport.local');
    if (savedState) localStorage.setItem('cctv-map-state-v2', savedState);
  }, { savedState: state });

  await page.goto(appUrl);
  await page.waitForLoadState('networkidle');
  await page.locator('[data-view="devices"]').click();
  return { context, page };
}

async function assertCameraUsesLocalIp(page) {
  const row = page.locator('#deviceTable tr', { hasText: CAMERA_ID });
  assert.equal(await row.count(), 1, `${CAMERA_ID} tidak muncul di inventaris`);
  const rowText = await row.innerText();
  assert.ok(
    rowText.includes(LOCAL_CAMERA_IP),
    `${CAMERA_ID} harus menampilkan ${LOCAL_CAMERA_IP}, tetapi barisnya berisi: ${rowText}`,
  );
}

async function main() {
  const { server, url } = await startServer();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    let session = await openInventory(browser, url);
    try {
      await assertCameraUsesLocalIp(session.page);
    } finally {
      await session.context.close();
    }

    const legacyCamera = {
      id: CAMERA_ID,
      area: 'Koridor utama',
      location: 'Dekat Gate B3',
      brand: 'Hikvision',
      model: 'DS-2CD2143G2-I',
      serial: 'HKV-T1-0021',
      color: 'Putih',
      shape: 'Dome',
      installed: '2024-03-12',
      ip: '192.168.10.121',
      streamUrl: '',
      angle: 315,
      status: 'normal',
      x: 51,
      y: 37,
      updated: '4 menit lalu',
    };
    session = await openInventory(browser, url, legacyCamera);
    try {
      await assertCameraUsesLocalIp(session.page);
    } finally {
      await session.context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  console.log('PASS: kamera lokal tampil dengan IP 192.168.1.64');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
