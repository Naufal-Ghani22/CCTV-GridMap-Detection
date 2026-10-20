// OS-level helpers: ICMP ping and the FFmpeg RTSP-to-MP4 bridge.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HttpError, SECURITY_HEADERS, sendJson } = require('./http');
const { acceptWebSocket, closeWebSocket, rejectUpgrade, sendBinary } = require('./websocket');

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (process.platform !== 'win32') return 'ffmpeg';
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

function pingCommand(ip, platform = process.platform) {
  return platform === 'win32'
    ? ['ping.exe', ['-n', '1', '-w', '1500', ip]]
    : ['ping', ['-c', '1', '-W', '2', ip]];
}

function runPing(ip) {
  return new Promise((resolve, reject) => {
    const [command, args] = pingCommand(ip);
    const child = spawn(command, args, { windowsHide: true, shell: false });
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
      const reply = /(?:time|waktu)\s*[=<]\s*(\d+(?:\.\d+)?)\s*ms/i.exec(output);
      finish(null, {
        status: code === 0 && reply ? 'online' : 'offline',
        latencyMs: code === 0 && reply ? Math.round(Number(reply[1])) : null,
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

function startFfmpegStream(url, executable = resolveFfmpegPath(), videoCodec = process.env.STREAM_VIDEO_CODEC) {
  // "copy" skips re-encoding for H.264 cameras and saves a lot of CPU on the control-room PC.
  const video = videoCodec === 'copy'
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30'];
  return spawn(executable, [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-i', url,
    '-map', '0:v:0', '-an',
    ...video,
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1',
  ], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
}

function createStreamManager({
  startStream = startFfmpegStream,
  logError = console.error,
  maxTotal = 8,
  maxPerUser = 4,
  ttlMs = 10 * 60 * 1000,
} = {}) {
  const sessions = new Map();

  function remove(token) {
    const session = sessions.get(token);
    if (!session) return;
    clearTimeout(session.expires);
    session.child?.kill();
    sessions.delete(token);
  }

  // Only an idle token expires: a stream that is being watched (e.g. on a video wall) stays open.
  function armExpiry(token) {
    const session = sessions.get(token);
    if (!session) return;
    clearTimeout(session.expires);
    session.expires = setTimeout(() => remove(token), ttlMs);
    session.expires.unref();
  }

  // Starts FFmpeg for one viewer (HTTP response or WebSocket). A new viewer replaces the previous one;
  // when the viewer leaves, FFmpeg stops and the token goes back to expiring.
  function play(token, session, viewer) {
    session.child?.kill();
    clearTimeout(session.expires);
    const child = startStream(session.url);
    session.child = child;
    let errorText = '';
    child.stderr.on('data', (chunk) => {
      if (errorText.length < 2000) errorText += chunk.toString();
    });
    child.on('error', (error) => {
      logError('Proses tayangan gagal dimulai:', error.message);
      viewer.destroy();
    });
    child.on('close', (code) => {
      if (session.child === child) session.child = null;
      if (code && errorText) logError('Tayangan RTSP terputus:', errorText.trim().replace(/rtsp:\/\/[^\s]+/gi, '[URL RTSP disembunyikan]'));
      viewer.end();
    });
    viewer.onClose(() => {
      if (session.child === child) {
        child.kill();
        session.child = null;
      }
      if (!session.child && sessions.get(token) === session) armExpiry(token);
    });
    return child;
  }

  return {
    create(user, url, cameraCode) {
      const mine = [...sessions.values()].filter((session) => session.userId === user.id);
      if (mine.length >= maxPerUser) {
        // Reclaim the oldest session of this user instead of refusing: a closed tab never says goodbye.
        const oldest = [...sessions.entries()].filter(([, session]) => session.userId === user.id).sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
        if (oldest) remove(oldest[0]);
      }
      if (sessions.size >= maxTotal) throw new HttpError(429, 'stream_limit', `Batas ${maxTotal} tayangan bersamaan tercapai. Tutup tayangan lain lalu coba lagi.`);
      const token = crypto.randomBytes(16).toString('hex');
      sessions.set(token, { url, cameraCode, userId: user.id, child: null, expires: null, createdAt: Date.now() });
      armExpiry(token);
      return token;
    },

    handle(request, response, token, user) {
      const session = sessions.get(token);
      if (!session || session.userId !== user.id) return sendJson(response, 404, { error: 'stream_not_found', message: 'Sesi tayangan sudah berakhir.' });
      if (request.method === 'DELETE') {
        remove(token);
        return sendJson(response, 204);
      }
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET, DELETE');
        return sendJson(response, 405, { error: 'method_not_allowed', message: 'Metode tidak didukung.' });
      }
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      response.flushHeaders();
      const child = play(token, session, {
        end: () => { if (!response.writableEnded) response.end(); },
        destroy: () => response.destroy(),
        onClose: (listener) => response.on('close', listener),
      });
      child.stdout.pipe(response);
      return undefined;
    },

    // Same stream as handle() but framed over a WebSocket (used by the View wall).
    handleSocket(request, socket, token, user) {
      const session = sessions.get(token);
      if (!session || session.userId !== user.id) return rejectUpgrade(socket, 404);
      if (!acceptWebSocket(request, socket)) return undefined;
      const child = play(token, session, {
        end: () => closeWebSocket(socket),
        destroy: () => socket.destroy(),
        onClose: (listener) => socket.on('close', listener),
      });
      child.stdout.on('data', (chunk) => {
        if (!socket.writable || sendBinary(socket, chunk)) return;
        // A slow viewer pauses FFmpeg instead of buffering video without bound.
        child.stdout.pause();
        socket.once('drain', () => child.stdout.resume());
      });
      return undefined;
    },

    count: () => sessions.size,
    countFor: (userId) => [...sessions.values()].filter((session) => session.userId === userId).length,
    // What one user can actually hold at once: the total cap wins when it is lower.
    limits: () => ({ maxTotal, maxPerUser: Math.min(maxPerUser, maxTotal) }),
    closeAll() {
      for (const token of [...sessions.keys()]) remove(token);
    },
  };
}

module.exports = { canRunFfmpeg, createStreamManager, pingCommand, resolveFfmpegPath, runPing, startFfmpegStream };
