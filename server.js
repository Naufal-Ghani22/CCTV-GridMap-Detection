const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { verifyPassword } = require('./lib/passwords');
const { createSession, getSessionUser, tokenDigest } = require('./lib/sessions');
const { encryptRtsp } = require('./lib/rtsp-secrets');

const ROOT = __dirname;
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/sha256.js', ['sha256.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function isValidIpv4(ip) {
  if (typeof ip !== 'string') return false;
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((part) =>
    /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isPrivateIpv4(ip) {
  if (!isValidIpv4(ip)) return false;
  const [first, second] = ip.split('.').map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function parseRtspUrl(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'rtsp:' || !isPrivateIpv4(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const packagesRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    : '';
  try {
    const packageName = fs.readdirSync(packagesRoot).find((name) => name.startsWith('Gyan.FFmpeg_'));
    const packageRoot = packageName ? path.join(packagesRoot, packageName) : '';
    const buildName = fs.readdirSync(packageRoot).find((name) => name.startsWith('ffmpeg-'));
    const candidate = buildName ? path.join(packageRoot, buildName, 'bin', 'ffmpeg.exe') : '';
    if (candidate && fs.existsSync(candidate)) return candidate;
  } catch {
    // Fall through to PATH when WinGet is unavailable or uses another layout.
  }
  return 'ffmpeg.exe';
}

function runPing(ip) {
  return new Promise((resolve, reject) => {
    const child = spawn('ping.exe', ['-n', '1', '-w', '1500', ip], { windowsHide: true, shell: false });
    let output = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(null, { status: 'offline', latencyMs: null });
    }, 3000);
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      const reply = /(?:time|waktu)\s*[=<]\s*(\d+)\s*ms/i.exec(output);
      finish(null, {
        status: code === 0 && reply ? 'online' : 'offline',
        latencyMs: code === 0 && reply ? Number(reply[1]) : null,
      });
    });
  });
}

function canRunFfmpeg(executable = resolveFfmpegPath()) {
  return new Promise((resolve) => {
    const child = spawn(executable, ['-version'], { windowsHide: true, shell: false });
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(available);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 3000);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

function startFfmpegStream(url, executable = resolveFfmpegPath()) {
  return spawn(executable, [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-i', url,
    '-map', '0:v:0', '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1',
  ], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

function readBody(request, limit = 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let content = '';
    let tooLarge = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else content += chunk.toString();
    });
    request.on('end', () => tooLarge ? reject(Object.assign(new Error('Body too large'), { status: 413 })) : resolve(content));
    request.on('error', reject);
  });
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return ['', ''];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function sendSessionCookie(response, token) {
  response.setHeader('Set-Cookie', `cctv_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', 'cctv_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

function cameraResponse(row) {
  const details = row.details || {};
  return {
    id: row.camera_code,
    name: row.name,
    area: row.area,
    ip: String(row.ip_address || '').replace(/\/32$/, ''),
    x: Number(row.map_x ?? 50),
    y: Number(row.map_y ?? 50),
    ...details,
  };
}

function createServer({
  ping = runPing,
  logError = console.error,
  streamAvailable = canRunFfmpeg,
  startStream = startFfmpegStream,
  pool = null,
  rtspEncryptionKey = null,
} = {}) {
  const streamSessions = new Map();
  const server = http.createServer(async (request, response) => {
    const route = request.url?.split('?')[0];
    if (route === '/api/auth/login') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return sendJson(response, 405, { error: 'method_not_allowed', message: 'Gunakan POST untuk masuk.' });
      }
      if (!pool) return sendJson(response, 503, { error: 'database_unavailable', message: 'Database belum terhubung.' });
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
        return sendJson(response, 400, { error: 'invalid_content_type', message: 'Kirim data JSON.' });
      }
      try {
        const raw = await readBody(request);
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
        const password = typeof data?.password === 'string' ? data.password : '';
        if (!email || !password) return sendJson(response, 400, { error: 'invalid_credentials', message: 'Masukkan email dan kata sandi.' });
        const found = await pool.query('SELECT id, email, password_hash, role FROM users WHERE email = $1', [email]);
        const user = found.rows[0];
        if (!user || !await verifyPassword(password, user.password_hash)) {
          return sendJson(response, 401, { error: 'invalid_credentials', message: 'Email atau kata sandi tidak sesuai.' });
        }
        const { token } = await createSession(pool, user.id);
        sendSessionCookie(response, token);
        return sendJson(response, 200, { user: { id: user.id, email: user.email, role: user.role } });
      } catch (error) {
        if (error.status === 413) return sendJson(response, 413, { error: 'body_too_large', message: 'Permintaan terlalu besar.' });
        logError('Login gagal:', error.message);
        return sendJson(response, 500, { error: 'login_failed', message: 'Login tidak dapat diproses.' });
      }
    }

    if (route === '/api/auth/session') {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return sendJson(response, 405, { error: 'method_not_allowed', message: 'Gunakan GET untuk memeriksa sesi.' });
      }
      if (!pool) return sendJson(response, 503, { error: 'database_unavailable', message: 'Database belum terhubung.' });
      try {
        const user = await getSessionUser(pool, parseCookies(request.headers.cookie).cctv_session);
        return sendJson(response, 200, { user });
      } catch (error) {
        logError('Pemeriksaan sesi gagal:', error.message);
        return sendJson(response, 500, { error: 'session_failed', message: 'Sesi tidak dapat diperiksa.' });
      }
    }

    if (route === '/api/auth/logout') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return sendJson(response, 405, { error: 'method_not_allowed', message: 'Gunakan POST untuk keluar.' });
      }
      if (pool) {
        const token = parseCookies(request.headers.cookie).cctv_session;
        if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenDigest(token)]);
      }
      clearSessionCookie(response);
      return sendJson(response, 204, {});
    }

    if (route === '/api/cameras') {
      if (!pool) return sendJson(response, 503, { error: 'database_unavailable', message: 'Database belum terhubung.' });
      const user = await getSessionUser(pool, parseCookies(request.headers.cookie).cctv_session);
      if (!user) return sendJson(response, 401, { error: 'authentication_required', message: 'Silakan masuk terlebih dahulu.' });
      if (request.method === 'GET') {
        try {
          const result = await pool.query('SELECT camera_code, name, area, ip_address::text, map_x, map_y, details FROM cameras ORDER BY camera_code');
          return sendJson(response, 200, result.rows.map(cameraResponse));
        } catch (error) {
          logError('Daftar CCTV gagal:', error.message);
          return sendJson(response, 500, { error: 'camera_list_failed', message: 'Daftar CCTV tidak dapat dibaca.' });
        }
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST');
        return sendJson(response, 405, { error: 'method_not_allowed', message: 'Metode tidak didukung.' });
      }
      if (user.role !== 'admin') return sendJson(response, 403, { error: 'admin_required', message: 'Hanya administrator yang dapat menambah CCTV.' });
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return sendJson(response, 400, { error: 'invalid_content_type', message: 'Kirim data JSON.' });
      try {
        const raw = await readBody(request, 12 * 1024);
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        const id = typeof data?.id === 'string' ? data.id.trim().toUpperCase() : '';
        const name = typeof data?.name === 'string' ? data.name.trim() : id;
        const area = typeof data?.area === 'string' ? data.area.trim() : '';
        const ip = typeof data?.ip === 'string' && data.ip.trim() ? data.ip.trim() : null;
        if (!id || !name || !area || (ip && !isValidIpv4(ip))) return sendJson(response, 400, { error: 'invalid_camera', message: 'ID, nama, area, dan alamat IP CCTV harus valid.' });
        const streamUrl = typeof data.streamUrl === 'string' ? data.streamUrl.trim() : '';
        if (streamUrl && (!rtspEncryptionKey || !parseRtspUrl(streamUrl))) return sendJson(response, 400, { error: 'invalid_rtsp_url', message: 'URL RTSP harus memakai alamat IPv4 jaringan lokal.' });
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await client.query(
            'INSERT INTO cameras (id, camera_code, name, area, ip_address, map_x, map_y, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING camera_code, name, area, ip_address::text, map_x, map_y, details',
            [crypto.randomUUID(), id, name, area, ip, Number(data.x) || 50, Number(data.y) || 50, JSON.stringify({ location: data.location || '', status: data.status || 'normal', angle: Number(data.angle) || 0, brand: data.brand || '', model: data.model || '', serial: data.serial || '', color: data.color || '', shape: data.shape || '', installed: data.installed || '' })],
          );
          if (streamUrl) await client.query('INSERT INTO camera_streams (camera_id, encrypted_rtsp) SELECT id, $1 FROM cameras WHERE camera_code = $2', [encryptRtsp(streamUrl, rtspEncryptionKey), id]);
          await client.query('INSERT INTO activity_history (id, actor_id, action, subject_type, subject_id, details) SELECT $1, $2, $3, $4, id, $5 FROM cameras WHERE camera_code = $6', [crypto.randomUUID(), user.id, 'Menambah perangkat', 'camera', JSON.stringify({ cameraCode: id }), id]);
          await client.query('COMMIT');
          return sendJson(response, 201, cameraResponse(result.rows[0]));
        } catch (error) {
          await client.query('ROLLBACK');
          if (error.code === '23505') return sendJson(response, 409, { error: 'duplicate_camera', message: 'ID CCTV sudah digunakan.' });
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        if (error.status === 413) return sendJson(response, 413, { error: 'body_too_large', message: 'Data CCTV terlalu besar.' });
        logError('Penyimpanan CCTV gagal:', error.message);
        return sendJson(response, 500, { error: 'camera_save_failed', message: 'CCTV tidak dapat disimpan.' });
      }
    }
    if (route === '/api/ping') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return sendJson(response, 405, { error: 'method_not_allowed', message: 'Gunakan POST untuk ping.' });
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
        return sendJson(response, 400, { error: 'invalid_content_type', message: 'Kirim data JSON.' });
      }
      try {
        const raw = await readBody(request);
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        if (!isValidIpv4(data?.ip)) {
          return sendJson(response, 400, { error: 'invalid_ip', message: 'Masukkan alamat IPv4 yang valid, misalnya 192.168.1.64.' });
        }
        const result = await ping(data.ip);
        if (!result || !['online', 'offline'].includes(result.status)) throw new Error('Invalid ping result');
        return sendJson(response, 200, {
          status: result.status,
          ip: data.ip,
          latencyMs: result.status === 'online' ? result.latencyMs : null,
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (error.status === 413) return sendJson(response, 413, { error: 'body_too_large', message: 'Permintaan terlalu besar.' });
        logError('Ping gagal:', error);
        return sendJson(response, 500, { error: 'ping_failed', message: 'Layanan ping gagal. Periksa terminal server lalu coba lagi.' });
      }
    }

    if (route === '/api/streams') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return sendJson(response, 405, { error: 'method_not_allowed', message: 'Gunakan POST untuk membuat tayangan.' });
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
        return sendJson(response, 400, { error: 'invalid_content_type', message: 'Kirim data JSON.' });
      }
      try {
        const raw = await readBody(request);
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        if (!parseRtspUrl(data?.url)) {
          return sendJson(response, 400, { error: 'invalid_rtsp_url', message: 'Gunakan URL RTSP dengan alamat IPv4 jaringan lokal.' });
        }
        if (!await streamAvailable()) {
          return sendJson(response, 503, { error: 'stream_bridge_unavailable', message: 'Komponen tayangan RTSP belum tersedia di server.' });
        }
        const token = crypto.randomBytes(16).toString('hex');
        const expires = setTimeout(() => {
          streamSessions.get(token)?.child?.kill();
          streamSessions.delete(token);
        }, 10 * 60 * 1000);
        expires.unref();
        streamSessions.set(token, { url: data.url, child: null, expires });
        return sendJson(response, 201, { playbackUrl: `/api/streams/${token}` });
      } catch (error) {
        if (error.status === 413) return sendJson(response, 413, { error: 'body_too_large', message: 'URL tayangan terlalu panjang.' });
        logError('Sesi tayangan gagal dibuat:', error);
        return sendJson(response, 500, { error: 'stream_session_failed', message: 'Sesi tayangan tidak dapat dibuat.' });
      }
    }

    const streamRoute = /^\/api\/streams\/([a-f0-9]{32})$/.exec(route || '');
    if (streamRoute) {
      const token = streamRoute[1];
      const session = streamSessions.get(token);
      if (!session) return sendJson(response, 404, { error: 'stream_not_found', message: 'Sesi tayangan sudah berakhir.' });
      if (request.method === 'DELETE') {
        session.child?.kill();
        clearTimeout(session.expires);
        streamSessions.delete(token);
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        return response.end();
      }
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET, DELETE');
        return sendJson(response, 405, { error: 'method_not_allowed', message: 'Metode tidak didukung.' });
      }
      session.child?.kill();
      const child = startStream(session.url);
      session.child = child;
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      });
      response.flushHeaders();
      child.stdout.pipe(response);
      let errorText = '';
      child.stderr.on('data', (chunk) => {
        if (errorText.length < 2000) errorText += chunk.toString();
      });
      child.on('error', (error) => {
        logError('Proses tayangan gagal dimulai:', error.message);
        response.destroy();
      });
      child.on('close', (code) => {
        if (session.child === child) session.child = null;
        if (code && errorText) logError('Tayangan RTSP terputus:', errorText.trim().replace(/rtsp:\/\/[^\s]+/gi, '[URL RTSP disembunyikan]'));
        if (!response.writableEnded) response.end();
      });
      response.on('close', () => {
        if (session.child === child) {
          child.kill();
          session.child = null;
        }
      });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendJson(response, 405, { error: 'method_not_allowed', message: 'Metode tidak didukung.' });
    }
    const asset = ASSETS.get(route);
    if (!asset) return sendJson(response, 404, { error: 'not_found', message: 'Halaman tidak ditemukan.' });
    const [fileName, contentType] = asset;
    fs.readFile(path.join(ROOT, fileName), (error, contents) => {
      if (error) return sendJson(response, 500, { error: 'asset_failed', message: 'File aplikasi tidak dapat dibaca.' });
      response.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': contents.length,
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : contents);
    });
  });
  server.on('close', () => {
    for (const session of streamSessions.values()) {
      clearTimeout(session.expires);
      session.child?.kill();
    }
    streamSessions.clear();
  });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT harus antara 1 dan 65535.');
    process.exit(1);
  }
  try {
    const { loadEnvironment } = require('./config');
    const { createPool } = require('./db/client');
    const config = loadEnvironment();
    const pool = createPool(config.databaseUrl);
    const server = createServer({ pool, rtspEncryptionKey: config.rtspEncryptionKey });
    server.listen(port, '0.0.0.0', () => {
      console.log(`CCTV Grid Map: http://127.0.0.1:${port}`);
      for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
          if (address.family === 'IPv4' && !address.internal) console.log(`Akses LAN: http://${address.address}:${port}`);
        }
      }
    });
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
