const assert = require('node:assert/strict');
const os = require('node:os');
const { chromium } = require('playwright');
const { createServer } = require('../server');

function lanAddress() {
  const addresses = Object.values(os.networkInterfaces()).flat();
  return addresses.find((address) => address?.family === 'IPv4' && !address.internal && address.address.startsWith('192.168.1.'))?.address
    || addresses.find((address) => address?.family === 'IPv4' && !address.internal)?.address;
}

async function main() {
  const address = lanAddress();
  assert.ok(address, 'Komputer tidak memiliki alamat IPv4 LAN untuk tes ini');
  const server = process.env.CCTV_LAN_URL ? null : createServer();
  if (server) await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const url = process.env.CCTV_LAN_URL || `http://${address}:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    const environment = await page.evaluate(() => ({ secure: isSecureContext, subtle: typeof crypto.subtle }));
    console.log(`LAN browser context: ${JSON.stringify(environment)}`);
    await page.locator('[data-demo-account="admin"]').click();
    await page.locator('#loginPassword').fill('wrong-password');
    await page.locator('#loginButton').click();
    assert.match(await page.locator('#authError').innerText(), /Periksa kembali email dan kata sandi/);
    await page.locator('#loginPassword').fill('Admin123!');
    await page.locator('#loginButton').click();
    assert.equal(await page.locator('#authError').isVisible(), false, await page.locator('#authError').innerText());
    assert.equal(await page.locator('#appShell').isVisible(), true, 'Admin tidak berhasil masuk dari alamat LAN');
  } finally {
    await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
  console.log('PASS: login admin dari alamat LAN');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
