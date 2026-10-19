const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { audit } = require('../lib/audit');
const { HttpError, SECURITY_HEADERS, readBody, readJson, sendJson } = require('../lib/http');
const { FLOORS, isPrivateIpv4 } = require('../lib/validate');

const DEFAULT_AREAS = ['Checkin Keberangkatan', 'Kedatangan', 'Boarding'];
const FLOOR_FILES = { gf: 'ground-floor.svg', ff: 'first-floor.svg' };
const MAX_MAP_BYTES = 6 * 1024 * 1024;

async function readSetting(pool, key, fallback) {
  const row = (await pool.query('SELECT setting_value FROM settings WHERE setting_key = $1', [key])).rows[0];
  return row ? row.setting_value : fallback;
}

async function writeSetting(pool, key, value, userId) {
  await pool.query(
    `INSERT INTO settings (setting_key, setting_value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId],
  );
}

async function get({ response, deps }) {
  const rows = (await deps.pool.query(
    "SELECT setting_key, CASE WHEN setting_key LIKE 'map:%' THEN jsonb_build_object('name', setting_value->'name', 'uploadedAt', setting_value->'uploadedAt') ELSE setting_value END AS value FROM settings",
  )).rows;
  const values = Object.fromEntries(rows.map((row) => [row.setting_key, row.value]));
  return sendJson(response, 200, {
    nvrs: Array.isArray(values.nvrs) ? values.nvrs : [],
    areas: Array.isArray(values.areas) && values.areas.length ? values.areas : DEFAULT_AREAS,
    monitor: { intervalSec: deps.monitor.snapshot().intervalSec },
    maps: Object.fromEntries(FLOORS.map((floor) => [floor, values[`map:${floor}`] ? { custom: true, ...values[`map:${floor}`] } : { custom: false }])),
  });
}

function settingError(message) {
  return new HttpError(400, 'invalid_setting', message);
}

async function put({ request, response, params, user, deps }) {
  const key = params[0];
  const data = await readJson(request, 32 * 1024);
  let value;
  let text;
  if (key === 'nvrs') {
    if (!Array.isArray(data.nvrs) || data.nvrs.length > 64) throw settingError('Daftar NVR maksimal 64 server.');
    const seen = new Set();
    value = data.nvrs.map((item) => {
      const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 60) : '';
      const ip = typeof item?.ip === 'string' ? item.ip.trim() : '';
      const location = typeof item?.location === 'string' ? item.location.trim().slice(0, 80) : '';
      if (!name || !isPrivateIpv4(ip)) throw settingError('Setiap NVR butuh nama dan alamat IPv4 jaringan lokal.');
      if (seen.has(ip)) throw settingError(`Alamat ${ip} tercantum lebih dari sekali.`);
      seen.add(ip);
      const id = typeof item.id === 'string' && /^[a-z0-9-]{1,40}$/.test(item.id) ? item.id : crypto.randomUUID().slice(0, 8);
      return { id, name, ip, location };
    });
    text = `${value.length} server NVR`;
  } else if (key === 'areas') {
    if (!Array.isArray(data.areas) || !data.areas.length || data.areas.length > 50) throw settingError('Isi 1–50 area.');
    value = [...new Set(data.areas.map((area) => (typeof area === 'string' ? area.trim().slice(0, 80) : '')).filter(Boolean))];
    if (!value.length) throw settingError('Isi minimal satu area.');
    text = value.join(', ');
  } else if (key === 'monitor') {
    const seconds = Number(data.intervalSec);
    if (!Number.isFinite(seconds)) throw settingError('Interval pemantauan harus berupa angka detik.');
    value = { intervalSec: deps.monitor.setInterval(seconds) };
    text = `Interval ping ${value.intervalSec} detik`;
  } else {
    throw new HttpError(404, 'setting_not_found', 'Pengaturan tidak dikenal.');
  }
  await writeSetting(deps.pool, key, value, user.id);
  await audit(deps.pool, { actorId: user.id, action: 'Memperbarui pengaturan', subjectType: 'setting', text });
  if (key === 'nvrs') deps.monitor.runOnce().catch(() => {});
  deps.hub.broadcast('settings', { key });
  deps.hub.broadcast('history', {});
  return sendJson(response, 200, { [key]: value });
}

function floorParam(params) {
  if (!FLOORS.includes(params[0])) throw new HttpError(404, 'floor_not_found', 'Lantai tidak dikenal.');
  return params[0];
}

function sendSvg(response, svg) {
  response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' });
  response.end(svg);
}

async function getMap({ response, params, deps }) {
  const floor = floorParam(params);
  const custom = await readSetting(deps.pool, `map:${floor}`, null);
  if (custom?.svg) return sendSvg(response, custom.svg);
  return sendSvg(response, await fs.readFile(path.join(deps.root, 'maps', FLOOR_FILES[floor]), 'utf8'));
}

function checkSvg(svg) {
  const body = svg.replace(/^﻿/, '').replace(/^\s*<\?xml[^>]*>\s*/i, '').replace(/^\s*<!--[\s\S]*?-->\s*/g, '');
  if (!/^<svg[\s>]/i.test(body) || !/<\/svg>\s*$/i.test(body)) throw new HttpError(400, 'invalid_svg', 'File bukan SVG yang valid.');
  if (/<script|<foreignObject|<iframe|<object|<embed|\son[a-z]+\s*=|javascript:|<!ENTITY/i.test(body)) {
    throw new HttpError(400, 'unsafe_svg', 'SVG memuat skrip atau elemen aktif. Ekspor ulang tanpa skrip.');
  }
  if (!/viewBox\s*=/i.test(body.slice(0, 2000))) throw new HttpError(400, 'invalid_svg', 'SVG harus memiliki atribut viewBox.');
  return body;
}

async function putMap({ request, response, params, user, url, deps }) {
  const floor = floorParam(params);
  if (!/^image\/svg\+xml(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new HttpError(400, 'invalid_content_type', 'Kirim file SVG.');
  const svg = checkSvg(await readBody(request, MAX_MAP_BYTES));
  const name = (url.searchParams.get('name') || 'denah.svg').slice(0, 120);
  await writeSetting(deps.pool, `map:${floor}`, { svg, name, uploadedAt: new Date().toISOString() }, user.id);
  await audit(deps.pool, { actorId: user.id, action: 'Mengimpor denah SVG', subjectType: 'setting', text: `${floor.toUpperCase()} · ${name}` });
  deps.hub.broadcast('settings', { key: `map:${floor}` });
  deps.hub.broadcast('history', {});
  return sendJson(response, 200, { floor, custom: true, name });
}

async function deleteMap({ response, params, user, deps }) {
  const floor = floorParam(params);
  await deps.pool.query('DELETE FROM settings WHERE setting_key = $1', [`map:${floor}`]);
  await audit(deps.pool, { actorId: user.id, action: 'Mengganti denah', subjectType: 'setting', text: `${floor.toUpperCase()} kembali ke denah bawaan` });
  deps.hub.broadcast('settings', { key: `map:${floor}` });
  deps.hub.broadcast('history', {});
  return sendJson(response, 204);
}

module.exports = { DEFAULT_AREAS, checkSvg, deleteMap, get, getMap, put, putMap, readSetting };
