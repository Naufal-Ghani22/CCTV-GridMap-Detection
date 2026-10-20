const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createEventHub } = require('./lib/events');
const { HttpError, SECURITY_HEADERS, sendError, sendJson, sessionToken } = require('./lib/http');
const { canRunFfmpeg, createStreamManager, resolveFfmpegPath, runPing, startFfmpegStream } = require('./lib/media');
const { createMonitor } = require('./lib/monitor');
const { createRateLimiter } = require('./lib/rate-limit');
const { getSessionUser, pruneExpiredSessions } = require('./lib/sessions');
const { isPrivateIpv4, isValidIpv4, parseRtspUrl } = require('./lib/validate');
const cameras = require('./routes/cameras');
const history = require('./routes/history');
const network = require('./routes/network');
const reports = require('./routes/reports');
const settings = require('./routes/settings');
const users = require('./routes/users');

const ROOT = __dirname;
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml; charset=utf-8']],
  ['/maps/ground-floor.svg', ['maps/ground-floor.svg', 'image/svg+xml; charset=utf-8']],
  ['/maps/first-floor.svg', ['maps/first-floor.svg', 'image/svg+xml; charset=utf-8']],
]);

// [method, path, access, handler]. access: public (no session), session (optional user), user, admin.
const ROUTES = [
  ['POST', '/api/auth/login', 'public', users.login],
  ['GET', '/api/auth/session', 'session', users.session],
  ['POST', '/api/auth/logout', 'public', users.logout],
  ['PATCH', '/api/me', 'user', users.updateMe],
  ['GET', '/api/users', 'admin', users.list],
  ['POST', '/api/users', 'admin', users.create],
  ['PATCH', /^\/api\/users\/([0-9a-f-]{36})$/, 'admin', users.update],
  ['DELETE', /^\/api\/users\/([0-9a-f-]{36})$/, 'admin', users.remove],
  ['GET', '/api/cameras', 'user', cameras.list],
  ['POST', '/api/cameras', 'admin', cameras.create],
  ['POST', /^\/api\/cameras\/([^/]+)\/ping$/, 'user', cameras.ping],
  ['PATCH', /^\/api\/cameras\/([^/]+)$/, 'admin', cameras.update],
  ['DELETE', /^\/api\/cameras\/([^/]+)$/, 'admin', cameras.remove],
  ['GET', '/api/reports', 'user', reports.list],
  ['POST', '/api/reports', 'user', reports.create],
  ['PATCH', /^\/api\/reports\/([^/]+)$/, 'admin', reports.update],
  ['GET', '/api/history', 'user', history.list],
  ['GET', '/api/settings', 'user', settings.get],
  ['PUT', /^\/api\/settings\/([a-z]+)$/, 'admin', settings.put],
  ['GET', /^\/api\/maps\/([a-z]+)$/, 'user', settings.getMap],
  ['PUT', /^\/api\/maps\/([a-z]+)$/, 'admin', settings.putMap],
  ['DELETE', /^\/api\/maps\/([a-z]+)$/, 'admin', settings.deleteMap],
  ['GET', '/api/monitor', 'user', network.monitorStatus],
  ['POST', '/api/monitor/run', 'admin', network.monitorRun],
  ['GET', '/api/events', 'user', network.events],
  ['POST', '/api/ping', 'user', network.ping],
  ['POST', '/api/streams', 'user', network.createStream],
  ['GET', /^\/api\/streams\/([a-f0-9]{32})$/, 'user', network.stream],
  ['DELETE', /^\/api\/streams\/([a-f0-9]{32})$/, 'user', network.stream],
];

function matchRoute(method, route) {
  const allowed = [];
  for (const [routeMethod, pattern, access, handler] of ROUTES) {
    const params = typeof pattern === 'string' ? (pattern === route ? [] : null) : pattern.exec(route)?.slice(1) ?? null;
    if (!params) continue;
    if (routeMethod === method) return { access, handler, params };
    allowed.push(routeMethod);
  }
  return allowed.length ? { allowed } : null;
}

function serveAsset(request, response, route) {
  const asset = ASSETS.get(route);
  if (!asset) return sendJson(response, 404, { error: 'not_found', message: 'Halaman tidak ditemukan.' });
  const [fileName, contentType] = asset;
  fs.readFile(path.join(ROOT, fileName), (error, contents) => {
    if (error) return sendJson(response, 500, { error: 'asset_failed', message: 'File aplikasi tidak dapat dibaca.' });
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Content-Length': contents.length,
      'Cache-Control': 'no-cache',
    });
    return response.end(request.method === 'HEAD' ? undefined : contents);
  });
}

function createServer({
  ping = runPing,
  logError = console.error,
  streamAvailable = canRunFfmpeg,
  startStream = startFfmpegStream,
  pool = null,
  rtspEncryptionKey = null,
  monitorIntervalSec = 60,
  maxStreams = 8,
} = {}) {
  const hub = createEventHub();
  const streams = createStreamManager({ startStream, logError, maxTotal: maxStreams });
  const monitor = createMonitor({ pool, ping, hub, logError, intervalSec: monitorIntervalSec });
  const deps = {
    pool,
    hub,
    monitor,
    streams,
    ping,
    streamAvailable,
    rtspEncryptionKey,
    logError,
    root: ROOT,
    loginLimiter: createRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 }),
    loginIpLimiter: createRateLimiter({ max: 30, windowMs: 15 * 60 * 1000 }),
  };

  async function handle(request, response) {
    const url = new URL(request.url || '/', 'http://localhost');
    const route = url.pathname;
    const matched = route.startsWith('/api/') ? matchRoute(request.method, route) : null;

    if (!matched) {
      if (route.startsWith('/api/')) return sendJson(response, 404, { error: 'not_found', message: 'Endpoint tidak ditemukan.' });
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'method_not_allowed', message: 'Metode tidak didukung.' });
      return serveAsset(request, response, route);
    }
    if (matched.allowed) {
      response.setHeader('Allow', [...new Set(matched.allowed)].join(', '));
      return sendJson(response, 405, { error: 'method_not_allowed', message: 'Metode tidak didukung.' });
    }

    let user = null;
    if (matched.access !== 'public' || route === '/api/auth/login') {
      if (!pool) return sendJson(response, 503, { error: 'database_unavailable', message: 'Database belum terhubung.' });
    }
    if (matched.access !== 'public') {
      user = await getSessionUser(pool, sessionToken(request));
      if (!user && matched.access !== 'session') return sendJson(response, 401, { error: 'authentication_required', message: 'Silakan masuk terlebih dahulu.' });
      if (matched.access === 'admin' && user.role !== 'admin') return sendJson(response, 403, { error: 'admin_required', message: 'Hanya administrator yang dapat melakukan tindakan ini.' });
    }
    return matched.handler({ request, response, params: matched.params, user, url, deps });
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (error instanceof HttpError) {
        if (!response.headersSent) return sendError(response, error);
        return response.destroy();
      }
      logError('Permintaan gagal:', error.message);
      if (!response.headersSent) {
        const databaseDown = /ECONNREFUSED|ETIMEDOUT|terminat|Connection/i.test(error.message || '') || error.code === '57P01';
        return databaseDown
          ? sendJson(response, 503, { error: 'database_unavailable', message: 'Database tidak dapat dijangkau. Periksa layanan PostgreSQL.' })
          : sendJson(response, 500, { error: 'internal_error', message: 'Server mengalami gangguan. Coba lagi.' });
      }
      return response.destroy();
    });
  });
  server.on('close', () => {
    monitor.stop();
    streams.closeAll();
    hub.close();
  });
  server.monitor = monitor;
  server.hub = hub;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT harus antara 1 dan 65535.');
    process.exit(1);
  }
  process.on('unhandledRejection', (error) => console.error('Kesalahan tak tertangani:', error?.message || error));
  try {
    const { loadEnvironment } = require('./config');
    const { createPool } = require('./db/client');
    const { readSetting } = require('./routes/settings');
    const config = loadEnvironment();
    const pool = createPool(config.databaseUrl);
    pool.on('error', (error) => console.error('Koneksi database terputus:', error.message));
    const server = createServer({
      pool,
      rtspEncryptionKey: config.rtspEncryptionKey,
      monitorIntervalSec: Number(process.env.MONITOR_INTERVAL_SEC) || 60,
      maxStreams: Number(process.env.MAX_STREAMS) || 8,
    });
    server.listen(port, '0.0.0.0', async () => {
      console.log(`CCTV Grid Map: http://127.0.0.1:${port}`);
      for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
          if (address.family === 'IPv4' && !address.internal) console.log(`Akses LAN: http://${address.address}:${port}`);
        }
      }
      try {
        const saved = await readSetting(pool, 'monitor', null);
        if (saved?.intervalSec) server.monitor.setInterval(saved.intervalSec);
      } catch (error) {
        console.error('Pengaturan monitor belum dapat dibaca:', error.message);
      }
      if (process.env.MONITOR_DISABLED !== '1') {
        server.monitor.start();
        console.log(`Monitor ping aktif setiap ${server.monitor.snapshot().intervalSec} detik.`);
      }
    });
    const prune = setInterval(() => pruneExpiredSessions(pool).catch((error) => console.error('Pembersihan sesi gagal:', error.message)), 15 * 60 * 1000);
    prune.unref();
    server.on('error', (error) => {
      console.error('Server gagal dimulai:', error.message);
      process.exitCode = 1;
    });
    server.on('close', () => pool.end().catch(() => {}));
  } catch (error) {
    console.error('Server gagal dimulai:', error.message);
    process.exitCode = 1;
  }
}

module.exports = { createServer, isPrivateIpv4, isValidIpv4, parseRtspUrl, resolveFfmpegPath, runPing, startFfmpegStream };
