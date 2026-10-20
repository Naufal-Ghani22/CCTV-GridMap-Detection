// Shared HTTP helpers: JSON responses, body parsing, cookies, and security headers.

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

class HttpError extends Error {
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

function sendJson(response, status, data) {
  if (status === 204) {
    response.writeHead(204, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
    return response.end();
  }
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  return response.end(JSON.stringify(data));
}

function sendError(response, error) {
  return sendJson(response, error.status, { error: error.error, message: error.message });
}

function readBody(request, limit = 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on('end', () => (tooLarge
      ? reject(new HttpError(413, 'body_too_large', 'Permintaan terlalu besar.'))
      : resolve(Buffer.concat(chunks).toString('utf8'))));
    request.on('error', reject);
  });
}

function isJsonRequest(request) {
  return /^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '');
}

async function readJson(request, limit = 1024) {
  if (!isJsonRequest(request)) throw new HttpError(400, 'invalid_content_type', 'Kirim data JSON.');
  const raw = await readBody(request, limit);
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // Fall through to the shared validation error.
  }
  throw new HttpError(400, 'invalid_json', 'Data JSON tidak valid.');
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return ['', ''];
    try {
      return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
    } catch {
      return ['', ''];
    }
  }).filter(([key]) => key));
}

function sessionToken(request) {
  return parseCookies(request.headers.cookie).cctv_session;
}

function sendSessionCookie(response, token) {
  response.setHeader('Set-Cookie', `cctv_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', 'cctv_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

module.exports = {
  HttpError,
  SECURITY_HEADERS,
  clearSessionCookie,
  isJsonRequest,
  parseCookies,
  readBody,
  readJson,
  sendError,
  sendJson,
  sendSessionCookie,
  sessionToken,
};
