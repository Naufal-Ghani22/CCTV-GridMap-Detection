// Input validation shared by camera, network and settings routes.
const { HttpError } = require('./http');

const CAMERA_STATUSES = ['normal', 'warning', 'offline'];
const FLOORS = ['gf', 'ff'];
const SHAPES = ['Dome', 'Bullet', 'PTZ', 'Fisheye'];
const TEXT_FIELDS = ['location', 'brand', 'model', 'serial', 'color', 'notes'];
const DEFAULT_FOV = { Dome: 90, Bullet: 60, PTZ: 60, Fisheye: 360 };

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

function invalid(message) {
  return new HttpError(400, 'invalid_camera', message);
}

function text(value, label, max = 120) {
  if (typeof value !== 'string') throw invalid(`${label} harus berupa teks.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`${label} maksimal ${max} karakter.`);
  return trimmed;
}

function number(value, label, min, max) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw invalid(`${label} harus berupa angka.`);
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Validates a camera payload. With `current` the payload is a partial update:
 * only keys present in `data` change. Returns column values plus the merged details object.
 */
function normalizeCameraInput(data, current = null) {
  const has = (key) => Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined;
  const details = { ...(current?.details || {}) };
  const result = {
    code: current?.camera_code || null,
    name: current?.name || null,
    area: current?.area || null,
    ip: current ? (current.ip_address ? String(current.ip_address).replace(/\/32$/, '') : null) : null,
    x: current ? Number(current.map_x ?? 50) : 50,
    y: current ? Number(current.map_y ?? 50) : 50,
    details,
  };

  if (!current) {
    const code = typeof data.id === 'string' ? data.id.trim().toUpperCase() : '';
    if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(code)) throw invalid('ID CCTV 3–32 karakter: huruf, angka, dan tanda hubung.');
    result.code = code;
  }

  if (has('name')) result.name = text(data.name, 'Nama', 120) || null;
  if (has('area')) result.area = text(data.area, 'Area', 80) || null;
  if (!result.name) result.name = result.code;
  if (!result.area) throw invalid('Area CCTV wajib diisi.');

  if (has('ip')) {
    if (data.ip !== null && typeof data.ip !== 'string') throw invalid('Alamat IP harus berupa teks.');
    const ip = (data.ip || '').trim();
    if (ip && !isValidIpv4(ip)) throw invalid('Alamat IP CCTV tidak valid.');
    result.ip = ip || null;
  }
  if (has('x')) result.x = Number(number(data.x, 'Posisi X', 0, 100).toFixed(3));
  if (has('y')) result.y = Number(number(data.y, 'Posisi Y', 0, 100).toFixed(3));

  for (const key of TEXT_FIELDS) if (has(key)) details[key] = text(data[key], key, key === 'notes' ? 500 : 120);
  if (has('status')) {
    if (!CAMERA_STATUSES.includes(data.status)) throw invalid('Status CCTV tidak dikenal.');
    details.status = data.status;
  }
  if (has('shape')) {
    if (!SHAPES.includes(data.shape)) throw invalid('Bentuk CCTV tidak dikenal.');
    details.shape = data.shape;
  }
  if (has('floor')) {
    if (!FLOORS.includes(data.floor)) throw invalid('Lantai tidak dikenal.');
    details.floor = data.floor;
  }
  if (has('installed')) {
    if (typeof data.installed !== 'string' || (data.installed && !/^\d{4}-\d{2}-\d{2}$/.test(data.installed))) throw invalid('Tanggal pemasangan harus berformat YYYY-MM-DD.');
    details.installed = data.installed;
  }
  if (has('angle')) details.angle = Math.round(((number(data.angle, 'Arah', -3600, 3600) % 360) + 360) % 360);
  if (has('fov')) details.fov = Math.round(number(data.fov, 'Sudut pandang', 10, 360));
  if (has('range')) details.range = Number(number(data.range, 'Jangkauan', 0.2, 12).toFixed(2));
  if (has('nvr')) details.nvr = data.nvr === null ? '' : text(data.nvr, 'NVR', 40);

  details.status = details.status || 'normal';
  details.floor = details.floor || 'gf';
  details.shape = details.shape || 'Dome';
  details.angle = Number.isFinite(details.angle) ? details.angle : 0;
  details.fov = Number.isFinite(details.fov) ? details.fov : DEFAULT_FOV[details.shape] || 90;
  details.range = Number.isFinite(details.range) ? details.range : 1.5;
  return result;
}

module.exports = {
  CAMERA_STATUSES,
  DEFAULT_FOV,
  FLOORS,
  SHAPES,
  isPrivateIpv4,
  isValidIpv4,
  normalizeCameraInput,
  parseRtspUrl,
};
