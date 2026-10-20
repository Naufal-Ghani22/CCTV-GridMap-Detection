// Drives a headless Edge/Chrome through the DevTools Protocol without extra npm packages.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findBrowser() {
  return CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

async function launchBrowser({ width = 1600, height = 950 } = {}) {
  const executable = findBrowser();
  if (!executable) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-e2e-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const child = spawn(executable, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, '--no-first-run', '--disable-extensions', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((item) => item.type === 'page' && item.url === 'about:blank');
    } catch {
      // Browser is still starting.
    }
  }
  if (!target) {
    child.kill();
    throw new Error('Browser headless tidak dapat dijalankan.');
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const waiting = new Map();
  const errors = [];
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && waiting.has(data.id)) {
      waiting.get(data.id)(data);
      waiting.delete(data.id);
    }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') errors.push(data.params.entry.text);
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  for (const domain of ['Runtime', 'Log', 'Page', 'Network']) await send(`${domain}.enable`);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const page = {
    errors,
    async goto(url, settleMs = 2500) {
      await send('Page.navigate', { url });
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    },
    async setCookie(name, value, url) {
      await send('Network.setCookie', { name, value, url, httpOnly: true, sameSite: 'Strict' });
    },
    async eval(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description || 'Evaluasi gagal');
      return result.result?.result?.value;
    },
    async waitFor(expression, timeoutMs = 8000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (await page.eval(expression)) return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error(`Menunggu terlalu lama: ${expression}`);
    },
    async center(selector) {
      return page.eval(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]; })()`);
    },
    async drag(from, to, steps = 12) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0], y: from[1] });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', clickCount: 1, buttons: 1 });
      for (let step = 1; step <= steps; step += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0] + ((to[0] - from[0]) * step) / steps, y: from[1] + ((to[1] - from[1]) * step) / steps, button: 'left', buttons: 1 });
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', clickCount: 1, buttons: 0 });
    },
    async click(point) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: point[0], y: point[1], button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
      }
    },
    async screenshot(file) {
      const result = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(result.result.data, 'base64'));
    },
    async close() {
      socket.close();
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 300));
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  return page;
}

module.exports = { findBrowser, launchBrowser };
