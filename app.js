'use strict';

/* =========================================================================
   CCTV Map — control-room client.
   All shared data lives on the server (PostgreSQL). The browser keeps only
   view state plus a few per-viewer preferences in localStorage.
   ========================================================================= */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const FLOORS = { gf: 'Lantai dasar', ff: 'Lantai 1' };
const FLOOR_ORDER = Object.keys(FLOORS);
const STATUS_ORDER = { offline: 0, warning: 1, normal: 2 };
const DEFAULT_FOV = { Dome: 90, Bullet: 60, PTZ: 60, Fisheye: 360 };
const MIN_ZOOM = 1;
const MAX_ZOOM = 16;
const SAVE_DELAY_MS = 500;
const PREFS_KEY = 'cctv-map-prefs-v1';

const state = {
  user: null,
  cameras: [],
  reports: [],
  history: [],
  settings: { nvrs: [], areas: [], monitor: { intervalSec: 60 }, maps: {} },
  monitor: null,
  users: [],
  view: 'home',
  floor: 'gf',
  selectedId: null,
  hoverId: null,
  statusFilter: 'all',
  editMode: false,
  placing: false,
  dragging: false,
  reloadAfterDrag: false,
  reportFilter: 'active',
  deviceSort: { key: 'status', dir: 1 },
  loaded: false,
};

const prefs = loadPrefs();
const pending = new Map(); // camera id -> fields waiting to be saved
const undoStack = [];
const floorMarkup = {};
const minimapUrls = {};
const mapView = { zoom: 1, x: 0, y: 0, aspect: 7.7, fitted: false };

let events = null;
let eventsRetry = null;
let saveTimer = null;
let clockTimer = null;
let liveClockTimer = null;
let livePlaybackUrl = null;
let liveRequestId = 0;
let liveCameraId = null;
let pendingConfirm = null;
let audioContext = null;
let searchIndex = 0;

const mapArea = $('#mapArea');
const mapCanvas = $('#mapCanvas');
const cameraLayer = $('#cameraLayer');

/* ---------------------------------------------------------------- utils */

function loadPrefs() {
  const defaults = { theme: 'dark', sound: true, fov: true, labels: true, floor: 'gf' };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private window: keep in memory */ }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

const timeFormat = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' });
const dateTimeFormat = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' });
const dateFormat = new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeZone: 'Asia/Jakarta' });

function formatDate(value, withTime = false) {
  if (!value) return 'Belum ada';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return (withTime ? dateTimeFormat : dateFormat).format(date);
}

function relativeTime(value) {
  if (!value) return 'belum pernah';
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 5) return 'baru saja';
  if (seconds < 60) return `${seconds} dtk lalu`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} mnt lalu`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} jam lalu`;
  return formatDate(value, true);
}

function statusText(status) {
  return { normal: 'Normal', warning: 'Perlu perhatian', offline: 'Offline' }[status] || status;
}

function reportStatusText(status) {
  return { open: 'Baru', progress: 'Dikerjakan', resolved: 'Selesai' }[status] || status;
}

function priorityText(priority) {
  return { normal: 'Normal', high: 'Tinggi', critical: 'Kritis' }[priority] || priority;
}

const COMPASS = [
  ['Utara', 'U'], ['Timur laut', 'TL'], ['Timur', 'T'], ['Tenggara', 'TG'],
  ['Selatan', 'S'], ['Barat daya', 'BD'], ['Barat', 'B'], ['Barat laut', 'BL'],
];

function compass(angle) {
  return COMPASS[Math.round((((angle % 360) + 360) % 360) / 45) % 8];
}

function directionText(angle) {
  return `${compass(angle)[0]} · ${angle}°`;
}

function rangeText(range) {
  if (range < 1) return 'Pendek';
  if (range < 2.5) return 'Sedang';
  if (range < 5) return 'Jauh';
  return 'Sangat jauh';
}

function shortId(id) {
  return id.replace(/^CCTV-/, '');
}

function normalizeAngle(angle) {
  return ((Math.round(angle) % 360) + 360) % 360;
}

function wedgePath(fov, radius = 1) {
  if (fov >= 360) return `M0,${-radius}A${radius},${radius} 0 1,1 0,${radius}A${radius},${radius} 0 1,1 0,${-radius}Z`;
  const half = (fov / 2) * (Math.PI / 180);
  const x = (Math.sin(half) * radius).toFixed(4);
  const y = (-Math.cos(half) * radius).toFixed(4);
  return `M0,0L${-x},${y}A${radius},${radius} 0 ${fov > 180 ? 1 : 0},1 ${x},${y}Z`;
}

function isAdmin() {
  return state.user?.role === 'admin';
}

function cameraById(id) {
  return state.cameras.find((camera) => camera.id === id) || null;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function downloadCsv(name, rows) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------------------------------------------------------- toasts & sound */

function toast(message, { title = '', kind = 'info', action = null, duration = 4000 } = {}) {
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.innerHTML = `<div>${title ? `<strong>${escapeHtml(title)}</strong>` : ''}<span>${escapeHtml(message)}</span></div><div class="toast-actions"></div>`;
  const actions = $('.toast-actions', item);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button small';
    button.textContent = action.label;
    button.addEventListener('click', () => { action.run(); item.remove(); });
    actions.append(button);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button';
  close.setAttribute('aria-label', 'Tutup notifikasi');
  close.innerHTML = '<svg><use href="#i-x"/></svg>';
  close.addEventListener('click', () => item.remove());
  actions.append(close);
  const stack = $('#toastStack');
  stack.append(item);
  while (stack.children.length > 5) stack.firstElementChild.remove();
  if (duration) setTimeout(() => item.remove(), duration);
}

function beep(kind = 'alarm') {
  if (!prefs.sound) return;
  try {
    audioContext = audioContext || new AudioContext();
    const tones = kind === 'alarm' ? [880, 660, 880] : [520, 780];
    tones.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = frequency;
      oscillator.type = 'sine';
      const start = audioContext.currentTime + index * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.17);
    });
  } catch {
    // Audio may be blocked until the operator interacts with the page.
  }
}

/* ---------------------------------------------------------------- API */

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (typeof body === 'string' || body instanceof Blob) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', 'Server tidak dapat dijangkau. Periksa jaringan LAN.');
  }
  if (response.status === 401 && state.user && !path.startsWith('/api/auth/')) {
    sessionExpired();
    throw new ApiError(401, 'authentication_required', 'Sesi berakhir. Silakan masuk kembali.');
  }
  if (raw) {
    if (!response.ok) throw new ApiError(response.status, 'http', `Permintaan gagal (HTTP ${response.status}).`);
    return response;
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) throw new ApiError(response.status, data?.error, data?.message || `Permintaan gagal (HTTP ${response.status}).`);
  return data;
}

function reportError(error) {
  if (error?.status === 401) return;
  toast(error?.message || 'Terjadi kesalahan.', { kind: 'error', title: 'Gagal' });
}

/* ---------------------------------------------------------------- loaders */

async function loadCameras() {
  if (state.dragging) {
    // Re-rendering markers mid-drag would drop the pointer capture; reload when the drag ends.
    state.reloadAfterDrag = true;
    return;
  }
  const previous = new Map(state.cameras.map((camera) => [camera.id, camera.status]));
  const list = await api('/api/cameras');
  for (const camera of list) {
    const fields = pending.get(camera.id);
    if (fields) Object.assign(camera, fields);
  }
  state.cameras = list;
  if (state.loaded) detectTransitions(previous);
  renderCameraViews();
}

async function loadReports() {
  state.reports = await api('/api/reports');
  renderReports();
  renderDashboard();
  updateBadges();
  if (state.selectedId) renderDetail();
}

async function loadHistory() {
  state.history = await api('/api/history?limit=300');
  renderHistory();
  renderDashboard();
}

async function loadSettings() {
  const previousMaps = JSON.stringify(state.settings.maps || {});
  state.settings = await api('/api/settings');
  if (previousMaps !== JSON.stringify(state.settings.maps)) {
    for (const floor of FLOOR_ORDER) delete floorMarkup[floor];
    if (state.loaded) renderFloorPlan();
  }
  renderSettings();
  renderDashboard();
}

async function loadMonitor() {
  state.monitor = await api('/api/monitor');
  renderMonitor();
}

async function loadUsers() {
  if (!isAdmin()) return;
  state.users = await api('/api/users');
  renderUsers();
}

const loaders = { cameras: loadCameras, reports: loadReports, history: loadHistory, settings: loadSettings, monitor: loadMonitor, users: loadUsers };
const scheduled = {};

function scheduleLoad(kind, delay = 250) {
  clearTimeout(scheduled[kind]);
  scheduled[kind] = setTimeout(() => loaders[kind]().catch(reportError), delay);
}

async function loadAll() {
  await Promise.all([loadSettings(), loadCameras(), loadReports(), loadHistory(), loadMonitor(), loadUsers()]);
}

function detectTransitions(previous) {
  for (const camera of state.cameras) {
    const before = previous.get(camera.id);
    if (!before || before === camera.status) continue;
    if (camera.status === 'offline') {
      beep('alarm');
      toast(`${camera.location || camera.area} · ${FLOORS[camera.floor]}`, {
        title: `${camera.id} offline`,
        kind: 'alarm',
        duration: 0,
        action: { label: 'Lihat', run: () => locateCamera(camera.id) },
      });
    } else if (before === 'offline') {
      beep('recover');
      toast(`${camera.location || camera.area}`, { title: `${camera.id} kembali ${statusText(camera.status).toLowerCase()}`, kind: 'recover' });
    }
  }
}

/* ---------------------------------------------------------------- realtime */

function setSync(ok, text) {
  const pill = $('#syncPill');
  pill.classList.toggle('ok', ok);
  pill.classList.toggle('bad', !ok);
  $('#syncText').textContent = text || (ok ? 'Tersinkron' : 'Menyambung ulang…');
}

function connectEvents() {
  events?.close();
  clearTimeout(eventsRetry);
  events = new EventSource('/api/events');
  let hadError = false;
  events.addEventListener('hello', () => {
    setSync(true);
    if (hadError) {
      // Catch up on anything missed while disconnected.
      Object.keys(loaders).forEach((kind) => scheduleLoad(kind, 50));
      hadError = false;
    }
  });
  for (const kind of ['cameras', 'reports', 'history', 'settings', 'users']) {
    events.addEventListener(kind, () => scheduleLoad(kind));
  }
  events.addEventListener('monitor', (event) => {
    try { state.monitor = JSON.parse(event.data); } catch { /* keep previous */ }
    renderMonitor();
  });
  events.onerror = () => {
    hadError = true;
    setSync(false);
    if (events.readyState === EventSource.CLOSED) {
      eventsRetry = setTimeout(async () => {
        try {
          const { user } = await api('/api/auth/session');
          if (user) connectEvents();
          else sessionExpired();
        } catch {
          connectEvents();
        }
      }, 5000);
    }
  };
}

/* ---------------------------------------------------------------- floor plan */

function sanitizeSvg(source) {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.tagName.toLowerCase() !== 'svg') throw new Error('File bukan SVG yang valid.');
  parsed.querySelectorAll('script, foreignObject, iframe, object, embed').forEach((node) => node.remove());
  parsed.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'xlink:href') && /^(javascript:|https?:|data:text\/html)/.test(value)) || (name === 'style' && /(expression|url\s*\()/i.test(value))) node.removeAttribute(attribute.name);
    });
  });
  const svg = parsed.documentElement;
  if (!svg.getAttribute('viewBox')) {
    const width = parseFloat(svg.getAttribute('width')) || 1000;
    const height = parseFloat(svg.getAttribute('height')) || 660;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  return new XMLSerializer().serializeToString(svg);
}

async function floorSvg(floor) {
  if (!floorMarkup[floor]) {
    const response = await api(`/api/maps/${floor}`, { raw: true });
    floorMarkup[floor] = sanitizeSvg(await response.text());
    if (minimapUrls[floor]) URL.revokeObjectURL(minimapUrls[floor]);
    minimapUrls[floor] = URL.createObjectURL(new Blob([floorMarkup[floor]], { type: 'image/svg+xml' }));
  }
  return floorMarkup[floor];
}

async function renderFloorPlan() {
  const floor = state.floor;
  let markup;
  try {
    markup = await floorSvg(floor);
  } catch (error) {
    reportError(error);
    return;
  }
  if (floor !== state.floor) return;
  const host = $('#floorPlanHost');
  host.innerHTML = markup;
  const svg = $('svg', host);
  if (svg) {
    svg.classList.add('floor-plan');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Denah ${FLOORS[floor].toLowerCase()}`);
    const [, , width, height] = (svg.getAttribute('viewBox') || '0 0 1000 660').split(/[\s,]+/).map(Number);
    mapView.aspect = width > 0 && height > 0 ? width / height : 1000 / 660;
  }
  $('#minimapImage').src = minimapUrls[floor] || '';
  mapView.fitted = false;
  layoutMap();
}

/* ---------------------------------------------------------------- map viewport */

function baseMapSize() {
  const width = mapArea.clientWidth;
  const height = mapArea.clientHeight;
  return width / height > mapView.aspect ? { width: height * mapView.aspect, height } : { width, height: width / mapView.aspect };
}

function clampPan() {
  const base = baseMapSize();
  const width = base.width * mapView.zoom;
  const height = base.height * mapView.zoom;
  const areaWidth = mapArea.clientWidth;
  const areaHeight = mapArea.clientHeight;
  // Allow panning a little past the edge so markers near the border can reach the centre.
  const slackX = Math.min(areaWidth * 0.3, 200);
  const slackY = Math.min(areaHeight * 0.3, 200);
  mapView.x = width <= areaWidth ? (areaWidth - width) / 2 : Math.min(slackX, Math.max(areaWidth - width - slackX, mapView.x));
  mapView.y = height <= areaHeight ? (areaHeight - height) / 2 : Math.min(slackY, Math.max(areaHeight - height - slackY, mapView.y));
  return { width, height };
}

function fitMap(readable = true) {
  const base = baseMapSize();
  // The terminal is long and narrow, so open at a readable height instead of a thin strip.
  mapView.zoom = readable ? Math.min(3.5, Math.max(MIN_ZOOM, (mapArea.clientHeight * 0.85) / base.height)) : MIN_ZOOM;
  mapView.x = (mapArea.clientWidth - base.width * mapView.zoom) / 2;
  mapView.y = (mapArea.clientHeight - base.height * mapView.zoom) / 2;
}

function layoutMap() {
  if (!mapArea.clientWidth || !mapArea.clientHeight) return;
  if (!mapView.fitted) {
    fitMap(true);
    mapView.fitted = true;
  }
  const { width, height } = clampPan();
  mapCanvas.style.width = `${width}px`;
  mapCanvas.style.height = `${height}px`;
  mapCanvas.style.transform = `translate(${mapView.x}px, ${mapView.y}px)`;
  mapCanvas.style.setProperty('--map-w', `${width}px`);
  mapCanvas.style.setProperty('--wall-w', `${Math.min(3.2, 1 + mapView.zoom * 0.2).toFixed(2)}px`);
  mapArea.classList.toggle('compact', width < 1700);
  $('#zoomIn').disabled = mapView.zoom >= MAX_ZOOM;
  $('#zoomOut').disabled = mapView.zoom <= MIN_ZOOM;
  $('#zoomLevel').textContent = `${Math.round(mapView.zoom * 100)}%`;
  updateMinimapViewport();
  renderHandles();
}

function zoomMap(factor, clientX, clientY) {
  const bounds = mapArea.getBoundingClientRect();
  const originX = clientX === undefined ? bounds.width / 2 : clientX - bounds.left;
  const originY = clientY === undefined ? bounds.height / 2 : clientY - bounds.top;
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, mapView.zoom * factor));
  const ratio = zoom / mapView.zoom;
  mapView.x = originX - (originX - mapView.x) * ratio;
  mapView.y = originY - (originY - mapView.y) * ratio;
  mapView.zoom = zoom;
  layoutMap();
}

function centerOn(xPercent, yPercent, minZoom = 4) {
  if (mapView.zoom < minZoom) mapView.zoom = minZoom;
  const base = baseMapSize();
  mapView.x = mapArea.clientWidth / 2 - (xPercent / 100) * base.width * mapView.zoom;
  mapView.y = mapArea.clientHeight / 2 - (yPercent / 100) * base.height * mapView.zoom;
  layoutMap();
}

function focusCamera(camera) {
  if (!camera) return;
  centerOn(camera.x, camera.y, 4);
}

function updateMinimapViewport() {
  const minimap = $('#minimap');
  const width = mapCanvas.offsetWidth;
  const height = mapCanvas.offsetHeight;
  if (!width || !height) return;
  const rect = $('#minimapViewport');
  const left = Math.max(0, -mapView.x / width);
  const top = Math.max(0, -mapView.y / height);
  const right = Math.min(1, (mapArea.clientWidth - mapView.x) / width);
  const bottom = Math.min(1, (mapArea.clientHeight - mapView.y) / height);
  rect.style.left = `${left * 100}%`;
  rect.style.top = `${top * 100}%`;
  rect.style.width = `${Math.max(0, right - left) * 100}%`;
  rect.style.height = `${Math.max(0, bottom - top) * 100}%`;
  minimap.classList.toggle('hidden', mapView.zoom <= 1.05 && mapArea.clientWidth > 700);
}

function minimapJump(event) {
  const bounds = $('#minimap').getBoundingClientRect();
  const x = ((event.clientX - bounds.left) / bounds.width) * 100;
  const y = ((event.clientY - bounds.top) / bounds.height) * 100;
  centerOn(x, y, mapView.zoom);
}

/* Pan & pinch */
const mapPointers = new Map();
let mapGesture = null;

function beginMapGesture() {
  const points = [...mapPointers.values()];
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
  const distance = points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
  mapGesture = { center, distance, zoom: mapView.zoom, x: mapView.x, y: mapView.y, moved: false };
}

function startPan(event) {
  if (event.button !== 0 || event.target.closest('.camera, .handle, .map-controls, .minimap, .edit-dock, .compass-rose')) return;
  mapArea.setPointerCapture(event.pointerId);
  mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
  mapArea.classList.add('panning');
  beginMapGesture();
}

function moveMap(event) {
  if (!mapPointers.has(event.pointerId)) return;
  const pointer = mapPointers.get(event.pointerId);
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  const points = [...mapPointers.values()];
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
  if (Math.hypot(center.x - mapGesture.center.x, center.y - mapGesture.center.y) > 3) mapGesture.moved = true;
  if (points.length > 1 && mapGesture.distance) {
    const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    const bounds = mapArea.getBoundingClientRect();
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, mapGesture.zoom * (distance / mapGesture.distance)));
    const ratio = zoom / mapGesture.zoom;
    const originX = mapGesture.center.x - bounds.left;
    const originY = mapGesture.center.y - bounds.top;
    mapView.zoom = zoom;
    mapView.x = originX - (originX - mapGesture.x) * ratio + (center.x - mapGesture.center.x);
    mapView.y = originY - (originY - mapGesture.y) * ratio + (center.y - mapGesture.center.y);
  } else {
    mapView.x = mapGesture.x + center.x - mapGesture.center.x;
    mapView.y = mapGesture.y + center.y - mapGesture.center.y;
  }
  layoutMap();
}

function endPan(event) {
  if (!mapPointers.has(event.pointerId)) return;
  const moved = mapGesture?.moved;
  mapPointers.delete(event.pointerId);
  if (mapPointers.size) {
    beginMapGesture();
    return;
  }
  mapArea.classList.remove('panning');
  if (!moved && event.type === 'pointerup') mapClick(event);
}

function mapClick(event) {
  if (state.placing) {
    const bounds = mapCanvas.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 100;
    const y = ((event.clientY - bounds.top) / bounds.height) * 100;
    if (x < 0 || x > 100 || y < 0 || y > 100) return toast('Klik di dalam area denah.', { kind: 'error' });
    setPlacing(false);
    openDeviceDialog(null, { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), floor: state.floor });
    return;
  }
  if (state.selectedId && !state.editMode) closeDetail();
}

function setPlacing(on) {
  state.placing = Boolean(on && isAdmin());
  mapArea.classList.toggle('placing', state.placing);
  const banner = $('#mapBanner');
  banner.classList.toggle('hidden', !state.placing);
  banner.textContent = state.placing ? `Klik lokasi CCTV baru pada ${FLOORS[state.floor].toLowerCase()} · Esc untuk batal` : '';
}

/* ---------------------------------------------------------------- markers */

function cameraMatches(camera, query = $('#search').value.trim().toLowerCase()) {
  if (state.statusFilter !== 'all' && camera.status !== state.statusFilter) return false;
  if (!query) return true;
  return `${camera.id} ${camera.area} ${camera.location} ${camera.brand} ${camera.model} ${camera.ip} ${camera.serial}`.toLowerCase().includes(query);
}

function visibleCameras() {
  return state.cameras.filter((camera) => camera.floor === state.floor && cameraMatches(camera));
}

function markerElement(camera) {
  const marker = document.createElement('div');
  marker.className = `camera-marker status-${camera.status}`;
  marker.dataset.id = camera.id;
  applyMarkerGeometry(marker, camera);

  const fov = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  fov.setAttribute('class', 'camera-fov');
  fov.setAttribute('viewBox', '-1 -1 2 2');
  fov.setAttribute('aria-hidden', 'true');
  fov.innerHTML = `<path class="wedge" d="${wedgePath(camera.fov)}"/>${camera.fov < 360 ? '<line class="axis" x1="0" y1="0" x2="0" y2="-1"/>' : ''}`;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'camera';
  const badge = camera.status === 'offline' ? '<span class="badge" aria-hidden="true">×</span>' : camera.status === 'warning' ? '<span class="badge" aria-hidden="true">!</span>' : '';
  button.innerHTML = `${camera.fov < 360 ? '<span class="nose"></span>' : ''}<svg class="glyph" aria-hidden="true"><use href="#i-cam"/></svg>${badge}`;
  button.setAttribute('aria-label', `${camera.id}, ${statusText(camera.status)}, ${camera.location}, menghadap ${directionText(camera.angle)}`);

  const label = document.createElement('span');
  label.className = 'camera-label';
  label.textContent = shortId(camera.id);

  marker.append(fov, button, label);
  return marker;
}

function applyMarkerGeometry(marker, camera) {
  marker.style.left = `${camera.x}%`;
  marker.style.top = `${camera.y}%`;
  marker.style.setProperty('--dir', `${camera.angle}deg`);
  marker.style.setProperty('--range', camera.range);
}

function refreshMarker(camera) {
  const marker = cameraLayer.querySelector(`.camera-marker[data-id="${CSS.escape(camera.id)}"]`);
  if (!marker) return;
  applyMarkerGeometry(marker, camera);
  const path = $('.wedge', marker);
  if (path) path.setAttribute('d', wedgePath(camera.fov));
}

function renderMarkers() {
  cameraLayer.querySelectorAll('.camera-marker').forEach((node) => node.remove());
  const fragment = document.createDocumentFragment();
  const list = visibleCameras().sort((a, b) => STATUS_ORDER[b.status] - STATUS_ORDER[a.status]);
  for (const camera of list) fragment.append(markerElement(camera));
  cameraLayer.prepend(fragment);
  syncSelectionClasses();
  renderMinimapDots();
  renderHandles();
}

function syncSelectionClasses() {
  $$('.camera-marker', cameraLayer).forEach((marker) => {
    marker.classList.toggle('selected', marker.dataset.id === state.selectedId);
    marker.classList.toggle('hovered', marker.dataset.id === state.hoverId);
  });
  $$('.camera-row').forEach((row) => {
    row.setAttribute('aria-selected', String(row.dataset.id === state.selectedId));
    row.classList.toggle('hovered', row.dataset.id === state.hoverId);
  });
}

function setHover(id, sourceEvent = null) {
  state.hoverId = id;
  syncSelectionClasses();
  const tooltip = $('#markerTooltip');
  const camera = id ? cameraById(id) : null;
  if (!camera || !sourceEvent || state.editMode && id === state.selectedId) {
    tooltip.classList.add('hidden');
    return;
  }
  const marker = cameraLayer.querySelector(`.camera-marker[data-id="${CSS.escape(id)}"]`);
  if (!marker) return;
  const areaBounds = mapArea.getBoundingClientRect();
  const markerBounds = marker.getBoundingClientRect();
  const ping = camera.lastPing ? (camera.lastPing.status === 'online' ? `${camera.lastPing.latencyMs ?? '?'} ms` : 'tidak merespons') : 'belum di-ping';
  tooltip.innerHTML = `<strong>${escapeHtml(camera.id)}</strong>${escapeHtml(camera.location)}<br><span>${escapeHtml(statusText(camera.status))} · ${escapeHtml(directionText(camera.angle))} · ${escapeHtml(ping)}</span>`;
  tooltip.classList.remove('hidden');
  const left = Math.min(areaBounds.width - tooltip.offsetWidth - 8, Math.max(8, markerBounds.left - areaBounds.left + 20));
  const top = Math.max(8, markerBounds.top - areaBounds.top - tooltip.offsetHeight - 16);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function renderMinimapDots() {
  const host = $('#minimapDots');
  host.innerHTML = visibleCameras().map((camera) => `<i class="${camera.status}" style="left:${camera.x}%;top:${camera.y}%"></i>`).join('');
}

/* ---------------------------------------------------------------- edit handles */

function canvasPoint(camera) {
  return { x: (camera.x / 100) * mapCanvas.offsetWidth, y: (camera.y / 100) * mapCanvas.offsetHeight };
}

function radiusPx(camera) {
  return Math.max(32, (mapCanvas.offsetWidth * camera.range) / 100);
}

function polar(center, radius, angle) {
  const radians = (angle * Math.PI) / 180;
  return { x: center.x + Math.sin(radians) * radius, y: center.y - Math.cos(radians) * radius };
}

// Handles are updated in place while dragging: replacing a node would drop its pointer capture.
function renderHandles() {
  const camera = cameraById(state.selectedId);
  const existing = $$('.handle', cameraLayer);
  if (!state.editMode || !camera || camera.floor !== state.floor || !cameraMatches(camera)) {
    existing.forEach((node) => node.remove());
    $('.angle-readout', cameraLayer)?.remove();
    return;
  }
  const center = canvasPoint(camera);
  const radius = radiusPx(camera);
  const handles = [{ kind: 'tip', angle: camera.angle, label: 'Seret untuk mengubah arah dan jangkauan' }];
  if (camera.fov < 360) {
    handles.push({ kind: 'edge', angle: camera.angle - camera.fov / 2, label: 'Seret untuk mengubah lebar sudut pandang' });
    handles.push({ kind: 'edge', angle: camera.angle + camera.fov / 2, label: 'Seret untuk mengubah lebar sudut pandang' });
  }
  const reuse = existing.length === handles.length && existing.every((node) => node.dataset.camera === camera.id);
  if (!reuse) existing.forEach((node) => node.remove());
  handles.forEach((handle, index) => {
    let node = reuse ? existing[index] : null;
    if (!node) {
      node = document.createElement('button');
      node.type = 'button';
      node.className = `handle ${handle.kind}`;
      node.dataset.camera = camera.id;
      node.title = handle.label;
      node.setAttribute('aria-label', handle.label);
      node.addEventListener('pointerdown', (event) => startHandleDrag(event, handle.kind));
      cameraLayer.append(node);
    }
    const point = polar(center, radius, handle.angle);
    node.style.left = `${point.x}px`;
    node.style.top = `${point.y}px`;
  });
}

function showReadout(text, point) {
  let readout = $('.angle-readout', cameraLayer);
  if (!readout) {
    readout = document.createElement('span');
    readout.className = 'angle-readout';
    cameraLayer.append(readout);
  }
  readout.textContent = text;
  readout.style.left = `${point.x}px`;
  readout.style.top = `${point.y}px`;
}

function pointerAngle(event, camera) {
  const bounds = mapCanvas.getBoundingClientRect();
  const center = { x: bounds.left + (camera.x / 100) * bounds.width, y: bounds.top + (camera.y / 100) * bounds.height };
  const dx = event.clientX - center.x;
  const dy = event.clientY - center.y;
  return { angle: normalizeAngle((Math.atan2(dx, -dy) * 180) / Math.PI), distance: Math.hypot(dx, dy), width: bounds.width };
}

function beginDrag() {
  state.dragging = true;
}

function finishDrag() {
  state.dragging = false;
  if (state.reloadAfterDrag) {
    state.reloadAfterDrag = false;
    scheduleLoad('cameras', SAVE_DELAY_MS + 400);
  }
}

function startHandleDrag(event, kind) {
  event.preventDefault();
  event.stopPropagation();
  const camera = cameraById(state.selectedId);
  if (!camera) return;
  const node = event.currentTarget;
  node.setPointerCapture(event.pointerId);
  pushUndo(camera);
  beginDrag();
  const move = (moveEvent) => {
    const { angle, distance, width } = pointerAngle(moveEvent, camera);
    const step = moveEvent.shiftKey ? 1 : 5;
    if (kind === 'tip') {
      camera.angle = normalizeAngle(Math.round(angle / step) * step);
      camera.range = Number(Math.max(0.2, Math.min(12, (distance / width) * 100)).toFixed(2));
    } else {
      let diff = Math.abs(((angle - camera.angle + 540) % 360) - 180);
      diff = Math.round((diff * 2) / step) * step;
      camera.fov = Math.max(10, Math.min(355, diff)); // 360° (fisheye) is set with the slider
    }
    refreshMarker(camera);
    renderHandles();
    renderDirection(camera);
    const point = polar(canvasPoint(camera), radiusPx(camera), camera.angle);
    showReadout(kind === 'tip' ? `${compass(camera.angle)[1]} ${camera.angle}° · ${rangeText(camera.range)}` : `Sudut ${camera.fov}°`, point);
  };
  const end = () => {
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', end);
    node.removeEventListener('pointercancel', end);
    $('.angle-readout', cameraLayer)?.remove();
    queueSave(camera, ['angle', 'range', 'fov']);
    renderList();
    finishDrag();
  };
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
}

function startMarkerDrag(event, id, button) {
  if (!state.editMode || !isAdmin() || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  button.setPointerCapture(event.pointerId);
  const camera = cameraById(id);
  if (!camera) return;
  if (state.selectedId !== id) openDetail(id, { focus: false });
  const startX = event.clientX;
  const startY = event.clientY;
  let moved = false;
  const move = (moveEvent) => {
    if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) return;
    if (!moved) {
      pushUndo(camera);
      beginDrag();
    }
    moved = true;
    const bounds = mapCanvas.getBoundingClientRect();
    camera.x = Number(Math.max(0, Math.min(100, ((moveEvent.clientX - bounds.left) / bounds.width) * 100)).toFixed(2));
    camera.y = Number(Math.max(0, Math.min(100, ((moveEvent.clientY - bounds.top) / bounds.height) * 100)).toFixed(2));
    refreshMarker(camera);
    renderHandles();
    $('#positionX').value = camera.x;
    $('#positionY').value = camera.y;
  };
  const end = () => {
    button.removeEventListener('pointermove', move);
    button.removeEventListener('pointerup', end);
    button.removeEventListener('pointercancel', end);
    if (moved) {
      queueSave(camera, ['x', 'y']);
      renderMinimapDots();
      finishDrag();
    }
  };
  button.addEventListener('pointermove', move);
  button.addEventListener('pointerup', end);
  button.addEventListener('pointercancel', end);
}

/* ---------------------------------------------------------------- saving & undo */

function setSaveState(text, kind = '') {
  const node = $('#saveState');
  node.textContent = text;
  node.className = `save-state ${kind}`;
}

function pushUndo(camera) {
  undoStack.push({ id: camera.id, x: camera.x, y: camera.y, angle: camera.angle, fov: camera.fov, range: camera.range });
  if (undoStack.length > 50) undoStack.shift();
  $('#undoButton').disabled = false;
}

function undo() {
  const entry = undoStack.pop();
  $('#undoButton').disabled = undoStack.length === 0;
  if (!entry) return;
  const camera = cameraById(entry.id);
  if (!camera) return;
  Object.assign(camera, { x: entry.x, y: entry.y, angle: entry.angle, fov: entry.fov, range: entry.range });
  if (camera.floor !== state.floor) setFloor(camera.floor);
  refreshMarker(camera);
  renderHandles();
  if (state.selectedId === camera.id) renderDetail();
  queueSave(camera, ['x', 'y', 'angle', 'fov', 'range']);
  toast(`Perubahan ${camera.id} diurungkan.`);
}

function queueSave(camera, keys) {
  const fields = pending.get(camera.id) || {};
  for (const key of keys) fields[key] = camera[key];
  pending.set(camera.id, fields);
  setSaveState('Menunggu simpan…', 'saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, SAVE_DELAY_MS);
}

async function flushSaves() {
  clearTimeout(saveTimer);
  if (!pending.size) return;
  const batch = [...pending.entries()];
  pending.clear();
  setSaveState('Menyimpan…', 'saving');
  let failed = 0;
  for (const [id, fields] of batch) {
    try {
      await api(`/api/cameras/${encodeURIComponent(id)}`, { method: 'PATCH', body: fields });
    } catch (error) {
      failed += 1;
      reportError(error);
    }
  }
  if (failed) {
    setSaveState('Gagal menyimpan', 'error');
    scheduleLoad('cameras', 50);
  } else {
    setSaveState(`Tersimpan ${timeFormat.format(new Date()).slice(0, 5)}`, 'saved');
  }
}

/* ---------------------------------------------------------------- side panel */

function renderList() {
  const list = visibleCameras().sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id));
  const total = state.cameras.filter((camera) => camera.floor === state.floor).length;
  $('#listMeta').textContent = list.length === total ? `${total} CCTV di ${FLOORS[state.floor].toLowerCase()}` : `${list.length} dari ${total} CCTV di ${FLOORS[state.floor].toLowerCase()}`;
  const groups = [['offline', 'Offline'], ['warning', 'Perlu perhatian'], ['normal', 'Normal']];
  const host = $('#cameraList');
  if (!list.length) {
    host.innerHTML = `<li class="empty-note">${total ? 'Tidak ada CCTV yang cocok dengan filter.' : 'Belum ada CCTV di lantai ini.'}${isAdmin() && !total ? '<br>Tekan <b>Tambah CCTV</b> lalu klik lokasinya di denah.' : ''}</li>`;
    return;
  }
  host.innerHTML = groups.map(([status, title]) => {
    const items = list.filter((camera) => camera.status === status);
    if (!items.length) return '';
    return `<li class="group-title">${title} · ${items.length}</li>${items.map((camera) => {
      const ping = camera.lastPing;
      const latency = !camera.ip ? 'tanpa IP' : !ping ? '—' : ping.status === 'online' ? `${ping.latencyMs ?? '?'} ms` : 'timeout';
      return `<li><button type="button" class="camera-row" role="option" data-id="${escapeHtml(camera.id)}" aria-selected="false">
        <i class="status-dot ${camera.status}"></i>
        <span><strong>${escapeHtml(camera.id)}</strong><small>${escapeHtml(camera.location || camera.area)}</small></span>
        <span class="row-dir"><svg class="mini-arrow" viewBox="-10 -10 20 20" style="--dir:${camera.angle}deg" aria-hidden="true"><path d="M0-8 5 6 0 3-5 6z"/></svg>${compass(camera.angle)[1]} ${camera.angle}°<span class="row-latency ${ping?.status === 'offline' ? 'bad' : ''}">${latency}</span></span>
      </button></li>`;
    }).join('')}`;
  }).join('');
  syncSelectionClasses();
}

function renderDirection(camera) {
  $('#directionName').textContent = compass(camera.angle)[0];
  $('#directionDeg').textContent = `${camera.angle}°`;
  $('#fovText').textContent = camera.fov >= 360 ? '360° (fisheye)' : `${camera.fov}°`;
  $('#rangeText').textContent = `${rangeText(camera.range)} (${camera.range})`;
  $('#dialNeedle').setAttribute('transform', `rotate(${camera.angle})`);
  $('#dialKnob').setAttribute('transform', `rotate(${camera.angle})`);
  $('#dialFov').setAttribute('d', wedgePath(camera.fov, 50));
  $('#dialFov').setAttribute('transform', `rotate(${camera.angle})`);
  $('#dial').setAttribute('aria-valuenow', String(camera.angle));
  $('#dial').setAttribute('aria-valuetext', directionText(camera.angle));
  if (document.activeElement !== $('#angleInput')) $('#angleInput').value = camera.angle;
  $('#fovInput').value = camera.fov;
  $('#fovOut').textContent = `${camera.fov}°`;
  $('#rangeInput').value = camera.range;
  $('#rangeOut').textContent = camera.range;
  $$('.cardinal-buttons button').forEach((button) => button.classList.toggle('active', Number(button.dataset.angle) === camera.angle));
  if (document.activeElement !== $('#positionX')) $('#positionX').value = camera.x;
  if (document.activeElement !== $('#positionY')) $('#positionY').value = camera.y;
}

function renderPingCard(camera) {
  const card = $('#pingCard');
  const ping = camera.lastPing;
  if (!camera.ip) {
    card.innerHTML = '<span class="ping-indicator"></span><div>Alamat IP belum diatur<small>Status hanya dari laporan petugas.</small></div>';
    return;
  }
  if (!ping) {
    card.innerHTML = `<span class="ping-indicator"></span><div>${escapeHtml(camera.ip)} belum di-ping<small>Monitor otomatis akan memeriksa pada siklus berikutnya.</small></div>`;
    return;
  }
  const online = ping.status === 'online';
  const source = camera.statusSource === 'ping' ? ` · gagal ${ping.failures}× berturut-turut` : '';
  card.innerHTML = `<span class="ping-indicator ${online ? 'online' : 'offline'}"></span><div>${online ? `Merespons ${ping.latencyMs ?? '?'} ms` : 'Tidak merespons ping'}<small>${escapeHtml(camera.ip)} · ${relativeTime(ping.checkedAt)}${source}</small></div>`;
}

function renderDetail() {
  const camera = cameraById(state.selectedId);
  if (!camera) return closeDetail();
  $('#panelList').classList.add('hidden');
  $('#panelDetail').classList.remove('hidden');
  $('#detailArea').textContent = `${camera.area} · ${FLOORS[camera.floor]}`;
  $('#detailId').textContent = camera.id;
  const status = $('#detailStatus');
  status.className = `status-label ${camera.status}`;
  status.textContent = statusText(camera.status);
  $('#detailLocation').textContent = camera.location || 'Lokasi belum diisi';
  $('#detailDevice').textContent = [camera.brand, camera.model].filter(Boolean).join(' ') || '—';
  $('#detailColor').textContent = [camera.shape, camera.color].filter(Boolean).join(', ') || '—';
  $('#detailSerial').textContent = camera.serial || '—';
  $('#detailIp').textContent = camera.ip || 'Belum diatur';
  const nvr = state.settings.nvrs.find((item) => item.id === camera.nvr);
  $('#detailNvr').textContent = nvr ? `${nvr.name} (${nvr.ip})` : '—';
  $('#detailInstalled').textContent = camera.installed ? formatDate(camera.installed) : '—';
  $('#detailUpdated').textContent = camera.updatedAt ? relativeTime(camera.updatedAt) : '—';
  $('#detailNotes').textContent = camera.notes || '';
  $('#detailNotes').classList.toggle('hidden', !camera.notes);
  $('#liveView').title = camera.hasStream ? 'Buka tayangan langsung' : 'URL tayangan belum diatur';
  $('#pingNow').disabled = !camera.ip;
  renderDirection(camera);
  renderPingCard(camera);
  const active = state.reports.filter((report) => report.cameraId === camera.id && report.status !== 'resolved');
  $('#detailReports').innerHTML = active.length ? `<h3>Laporan aktif (${active.length})</h3>${active.map((report) => `<div class="mini-report"><strong>${escapeHtml(report.issue)}</strong><span><span class="pill ${report.priority === 'normal' ? 'normal-priority' : report.priority}">${priorityText(report.priority)}</span> · ${escapeHtml(reportStatusText(report.status))} · ${escapeHtml(report.reporter)}</span><span class="muted">${escapeHtml(report.note)}</span></div>`).join('')}` : '';
  updateEditControls();
}

function openDetail(id, { focus = true } = {}) {
  const camera = cameraById(id);
  if (!camera) return;
  state.selectedId = id;
  if (camera.floor !== state.floor) {
    setFloor(camera.floor);
    requestAnimationFrame(() => focusCamera(camera));
  } else if (focus) {
    const bounds = mapArea.getBoundingClientRect();
    const markerX = mapView.x + (camera.x / 100) * mapCanvas.offsetWidth;
    const markerY = mapView.y + (camera.y / 100) * mapCanvas.offsetHeight;
    // Only move the map when the marker is out of view or the map is zoomed far out.
    if (mapView.zoom < 2 || markerX < 40 || markerY < 40 || markerX > bounds.width - 40 || markerY > bounds.height - 40) focusCamera(camera);
  }
  if (!cameraMatches(camera)) {
    state.statusFilter = 'all';
    $('#search').value = '';
    syncChips();
    renderMarkers();
    renderList();
  }
  renderDetail();
  syncSelectionClasses();
  renderHandles();
}

function closeDetail() {
  state.selectedId = null;
  $('#panelDetail').classList.add('hidden');
  $('#panelList').classList.remove('hidden');
  syncSelectionClasses();
  renderHandles();
}

function locateCamera(id) {
  showView('map');
  requestAnimationFrame(() => {
    const camera = cameraById(id);
    if (!camera) return toast('CCTV ini sudah dihapus.', { kind: 'error' });
    openDetail(id, { focus: false });
    focusCamera(camera);
  });
}

function stepSelection(delta) {
  const list = visibleCameras().sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id));
  if (!list.length) return;
  const index = list.findIndex((camera) => camera.id === state.selectedId);
  const next = list[(index + delta + list.length) % list.length];
  openDetail(next.id, { focus: false });
  focusCamera(next);
}

/* ---------------------------------------------------------------- edit mode */

function setEditMode(on) {
  state.editMode = Boolean(on && isAdmin());
  mapArea.classList.toggle('editing', state.editMode);
  $('#editToggle').setAttribute('aria-pressed', String(state.editMode));
  $('#editToggleText').textContent = state.editMode ? 'Selesai edit' : 'Edit peta';
  $('#editDock').classList.toggle('hidden', !state.editMode);
  if (state.editMode) setSaveState(state.selectedId ? 'Mode edit' : 'Pilih CCTV untuk diedit');
  else flushSaves();
  updateEditControls();
  renderHandles();
}

function updateEditControls() {
  const enabled = state.editMode && Boolean(state.selectedId);
  $('#directionEdit').classList.toggle('hidden', !enabled);
  $('#dial').classList.toggle('editable', enabled);
  $('#dial').tabIndex = enabled ? 0 : -1;
}

function editSelected(changes) {
  const camera = cameraById(state.selectedId);
  if (!camera || !state.editMode) return;
  pushUndo(camera);
  if ('angle' in changes) camera.angle = normalizeAngle(changes.angle);
  if ('fov' in changes) camera.fov = Math.max(10, Math.min(360, Math.round(changes.fov)));
  if ('range' in changes) camera.range = Number(Math.max(0.2, Math.min(12, changes.range)).toFixed(2));
  if ('x' in changes) camera.x = Number(Math.max(0, Math.min(100, changes.x)).toFixed(2));
  if ('y' in changes) camera.y = Number(Math.max(0, Math.min(100, changes.y)).toFixed(2));
  refreshMarker(camera);
  renderHandles();
  renderDirection(camera);
  queueSave(camera, Object.keys(changes));
}

function startDialDrag(event) {
  if (!state.editMode || !state.selectedId) return;
  const dial = $('#dial');
  dial.setPointerCapture(event.pointerId);
  const camera = cameraById(state.selectedId);
  pushUndo(camera);
  beginDrag();
  const update = (moveEvent) => {
    const bounds = dial.getBoundingClientRect();
    const dx = moveEvent.clientX - (bounds.left + bounds.width / 2);
    const dy = moveEvent.clientY - (bounds.top + bounds.height / 2);
    const step = moveEvent.shiftKey ? 1 : 5;
    camera.angle = normalizeAngle(Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI) / step) * step);
    refreshMarker(camera);
    renderHandles();
    renderDirection(camera);
  };
  update(event);
  const end = () => {
    dial.removeEventListener('pointermove', update);
    dial.removeEventListener('pointerup', end);
    dial.removeEventListener('pointercancel', end);
    queueSave(camera, ['angle']);
    renderList();
    finishDrag();
  };
  dial.addEventListener('pointermove', update);
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
}

/* ---------------------------------------------------------------- floors & chips */

function renderFloorTabs() {
  $('#floorTabs').innerHTML = FLOOR_ORDER.map((floor) => {
    const cams = state.cameras.filter((camera) => camera.floor === floor);
    const offline = cams.filter((camera) => camera.status === 'offline').length;
    return `<button type="button" role="tab" data-floor="${floor}" aria-selected="${floor === state.floor}">${FLOORS[floor]} <b class="${offline ? 'alert' : ''}" title="${offline ? `${offline} offline` : `${cams.length} CCTV`}">${offline || cams.length}</b></button>`;
  }).join('');
}

function setFloor(floor) {
  if (!FLOORS[floor] || floor === state.floor) return;
  state.floor = floor;
  prefs.floor = floor;
  savePrefs();
  const selected = cameraById(state.selectedId);
  if (selected && selected.floor !== floor) closeDetail();
  if (state.placing) setPlacing(true);
  renderFloorTabs();
  renderFloorPlan();
  renderMarkers();
  renderList();
  syncChips();
}

function syncChips() {
  const onFloor = state.cameras.filter((camera) => camera.floor === state.floor);
  const count = (status) => onFloor.filter((camera) => camera.status === status).length;
  $('#chipAll').textContent = onFloor.length;
  $('#chipNormal').textContent = count('normal');
  $('#chipWarning').textContent = count('warning');
  $('#chipOffline').textContent = count('offline');
  $$('#statusChips .chip').forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.status === state.statusFilter)));
}

function renderCameraViews() {
  renderFloorTabs();
  syncChips();
  renderMarkers();
  renderList();
  if (state.selectedId) {
    if (cameraById(state.selectedId)) renderDetail();
    else closeDetail();
  }
  renderDashboard();
  renderDeviceTable();
  renderCameraSelects();
  updateBadges();
}

/* ---------------------------------------------------------------- top bar */

function updateBadges() {
  const offline = state.cameras.filter((camera) => camera.status === 'offline').length;
  const activeReports = state.reports.filter((report) => report.status !== 'resolved').length;
  $('#reportBadge').textContent = activeReports;
  $('#reportBadge').classList.toggle('hidden', activeReports === 0);
  $('#alarmPill').classList.toggle('hidden', offline === 0);
  $('#alarmText').textContent = `${offline} CCTV offline`;
  document.title = `${offline ? `(${offline}) ` : ''}CCTV Map | Ruang Kontrol`;
}

function renderMonitor() {
  const monitor = state.monitor;
  const pill = $('#monitorPill');
  if (!monitor) return;
  const healthy = monitor.enabled && !monitor.lastError;
  pill.classList.toggle('ok', healthy);
  pill.classList.toggle('bad', Boolean(monitor.lastError));
  $('#monitorText').textContent = monitor.running ? 'Memeriksa…' : monitor.enabled ? `Ping ${relativeTime(monitor.lastRunAt)}` : 'Monitor mati';
  pill.title = monitor.lastError ? `Monitor bermasalah: ${monitor.lastError}` : `Ping otomatis setiap ${monitor.intervalSec} detik${monitor.lastDurationMs != null ? ` · siklus terakhir ${(monitor.lastDurationMs / 1000).toFixed(1)} dtk` : ''}`;
  $('#monitorDetail').textContent = monitor.enabled
    ? `Aktif setiap ${monitor.intervalSec} detik. Pemeriksaan terakhir ${relativeTime(monitor.lastRunAt)}${monitor.lastDurationMs != null ? ` (${(monitor.lastDurationMs / 1000).toFixed(1)} dtk)` : ''}.${monitor.lastError ? ` Galat: ${monitor.lastError}` : ''}`
    : 'Monitor tidak berjalan di server ini (MONITOR_DISABLED).';
  if (document.activeElement !== $('#monitorInterval')) $('#monitorInterval').value = monitor.intervalSec;
  renderNvrStatus();
}

function tickClock() {
  $('#clock').textContent = timeFormat.format(new Date());
  $('#clock').title = `${dateFormat.format(new Date())} WIB`;
}

function applyTheme() {
  document.documentElement.dataset.theme = prefs.theme;
  $('#themeToggle').innerHTML = `<svg><use href="#${prefs.theme === 'dark' ? 'i-sun' : 'i-moon'}"/></svg>`;
  $('#themeToggle').setAttribute('aria-label', prefs.theme === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap');
}

function applySound() {
  $('#soundToggle').setAttribute('aria-pressed', String(prefs.sound));
  $('#soundToggle').innerHTML = `<svg><use href="#${prefs.sound ? 'i-bell' : 'i-bell-off'}"/></svg>`;
  $('#soundToggle').setAttribute('aria-label', prefs.sound ? 'Matikan bunyi alarm' : 'Nyalakan bunyi alarm');
}

function applyLayers() {
  $('#layerFov').checked = prefs.fov;
  $('#layerLabels').checked = prefs.labels;
  mapArea.classList.toggle('hide-fov', !prefs.fov);
  mapArea.classList.toggle('hide-labels', !prefs.labels);
}

/* ---------------------------------------------------------------- dashboard */

function renderDashboard() {
  const cams = state.cameras;
  const count = (status) => cams.filter((camera) => camera.status === status).length;
  const normal = count('normal');
  const offline = count('offline');
  const warning = count('warning');
  const health = cams.length ? Math.round((normal / cams.length) * 100) : 0;
  const active = state.reports.filter((report) => report.status !== 'resolved');
  $('#dashTotal').textContent = cams.length;
  $('#dashCoverage').textContent = `${new Set(cams.map((camera) => camera.area)).size} area · ${FLOOR_ORDER.length} lantai`;
  $('#dashHealth').textContent = `${health}%`;
  $('#dashHealthBar').style.width = `${health}%`;
  $('#dashOffline').textContent = offline;
  $('#dashWarning').textContent = warning;
  $('#dashReports').textContent = active.length;
  $('#dashCritical').textContent = `${active.filter((report) => report.priority === 'critical').length} kritis`;
  $('.kpi[data-kpi="offline"]').classList.toggle('alive', offline > 0);

  const issues = cams.filter((camera) => camera.status !== 'normal').sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id));
  $('#dashboardAlerts').innerHTML = issues.length ? issues.slice(0, 8).map((camera) => {
    const why = camera.statusSource === 'ping' ? `Tidak merespons ping · ${relativeTime(camera.lastPing?.checkedAt)}` : (state.reports.find((report) => report.cameraId === camera.id && report.status !== 'resolved')?.issue || 'Status manual');
    return `<button type="button" class="alert-item" data-camera="${escapeHtml(camera.id)}"><i class="status-dot ${camera.status}"></i><span><strong class="mono">${escapeHtml(camera.id)}</strong><small>${escapeHtml(camera.location)} · ${FLOORS[camera.floor]} · ${escapeHtml(why)}</small></span><span class="status-label ${camera.status}">${statusText(camera.status)}</span></button>`;
  }).join('') + (issues.length > 8 ? `<p class="muted small">+${issues.length - 8} lainnya di peta.</p>` : '') : '<div class="empty-note">Semua CCTV beroperasi normal.</div>';

  $('#floorBreakdown').innerHTML = FLOOR_ORDER.map((floor) => {
    const list = cams.filter((camera) => camera.floor === floor);
    const total = Math.max(list.length, 1);
    const part = (status) => list.filter((camera) => camera.status === status).length;
    return `<button type="button" class="floor-row text-reset" data-floor-jump="${floor}" style="all:unset;cursor:pointer;display:block"><header><span>${FLOORS[floor]}</span><span class="muted">${list.length} CCTV · ${part('offline')} offline</span></header><div class="stack-bar">${['normal', 'warning', 'offline'].map((status) => `<i class="${status}" style="width:${(part(status) / total) * 100}%"></i>`).join('')}</div></button>`;
  }).join('');

  $('#dashboardReports').innerHTML = state.reports.length ? state.reports.slice(0, 5).map((report) => `<div class="compact-item"><span><strong>${escapeHtml(report.issue)}</strong><small>${escapeHtml(report.cameraId)} · ${relativeTime(report.createdAt)}</small></span><span class="pill ${report.status}">${reportStatusText(report.status)}</span></div>`).join('') : '<div class="empty-note">Belum ada laporan.</div>';
  $('#dashboardHistory').innerHTML = state.history.length ? state.history.slice(0, 6).map((item) => `<div class="compact-item"><span><strong>${escapeHtml(item.action)}</strong><small>${escapeHtml(item.detail)} · ${escapeHtml(item.actor)}</small></span><small>${relativeTime(item.createdAt)}</small></div>`).join('') : '<div class="empty-note">Belum ada aktivitas.</div>';
  renderNvrStatus();
}

function renderNvrStatus() {
  const nvrs = state.settings.nvrs || [];
  const status = new Map((state.monitor?.nvrs || []).map((item) => [item.ip, item]));
  const down = nvrs.filter((nvr) => status.get(nvr.ip)?.status === 'offline').length;
  $('#nvrSummary').textContent = nvrs.length ? `${nvrs.length} server · ${down ? `${down} tidak merespons` : 'semua merespons'}` : 'Belum ada NVR terdaftar.';
  $('#nvrList').innerHTML = nvrs.length ? nvrs.map((nvr) => {
    const result = status.get(nvr.ip);
    const cams = state.cameras.filter((camera) => camera.nvr === nvr.id).length;
    const label = !result ? '<span class="pill">Menunggu</span>' : result.status === 'online' ? `<span class="pill normal">${result.latencyMs ?? '?'} ms</span>` : '<span class="pill offline">Offline</span>';
    return `<div class="nvr-item"><svg><use href="#i-server"/></svg><span><strong>${escapeHtml(nvr.name)}</strong><small class="mono">${escapeHtml(nvr.ip)} · ${cams} CCTV${nvr.location ? ` · ${escapeHtml(nvr.location)}` : ''}</small></span>${label}</div>`;
  }).join('') : `<div class="empty-note">${isAdmin() ? 'Tambahkan NVR di Pengaturan agar ikut dipantau.' : 'Administrator belum mendaftarkan NVR.'}</div>`;
  $$('#nvrRows tr').forEach((row) => {
    const result = status.get($('[data-field="ip"]', row)?.value.trim());
    const cell = $('[data-status-cell]', row);
    if (cell) cell.innerHTML = !result ? '<span class="pill">—</span>' : result.status === 'online' ? `<span class="pill normal">${result.latencyMs ?? '?'} ms</span>` : '<span class="pill offline">Offline</span>';
  });
}

/* ---------------------------------------------------------------- devices table */

function renderDeviceTable() {
  const query = $('#deviceSearch').value.trim().toLowerCase();
  const status = $('#deviceStatusFilter').value;
  const floor = $('#deviceFloorFilter').value;
  const area = $('#deviceAreaFilter').value;
  const areas = [...new Set([...state.settings.areas, ...state.cameras.map((camera) => camera.area)])].sort();
  const currentArea = $('#deviceAreaFilter').value;
  $('#deviceAreaFilter').innerHTML = `<option value="all">Semua area</option>${areas.map((item) => `<option>${escapeHtml(item)}</option>`).join('')}`;
  $('#deviceAreaFilter').value = areas.includes(currentArea) ? currentArea : 'all';
  const { key, dir } = state.deviceSort;
  const value = (camera) => ({
    id: camera.id,
    location: `${camera.area} ${camera.location}`,
    floor: FLOOR_ORDER.indexOf(camera.floor),
    angle: camera.angle,
    ip: camera.ip ? camera.ip.split('.').map((part) => part.padStart(3, '0')).join('.') : 'zzz',
    ping: camera.lastPing?.status === 'online' ? camera.lastPing.latencyMs ?? 9998 : 9999,
    status: STATUS_ORDER[camera.status],
  }[key]);
  const list = state.cameras.filter((camera) => {
    const text = `${camera.id} ${camera.area} ${camera.location} ${camera.brand} ${camera.model} ${camera.serial} ${camera.ip}`.toLowerCase();
    return (!query || text.includes(query)) && (status === 'all' || camera.status === status) && (floor === 'all' || camera.floor === floor) && (area === 'all' || camera.area === area);
  }).sort((a, b) => {
    const left = value(a);
    const right = value(b);
    return (left > right ? 1 : left < right ? -1 : a.id.localeCompare(b.id)) * dir;
  });
  $$('.data-table th button[data-sort]').forEach((button) => button.setAttribute('aria-sort', button.dataset.sort === key ? (dir > 0 ? 'ascending' : 'descending') : 'none'));
  $('#deviceTable').innerHTML = list.map((camera) => {
    const ping = camera.lastPing;
    return `<tr>
      <td class="mono"><b>${escapeHtml(camera.id)}</b></td>
      <td>${escapeHtml(camera.location)}<small>${escapeHtml(camera.area)}</small></td>
      <td>${FLOORS[camera.floor]}</td>
      <td>${escapeHtml(camera.brand)} ${escapeHtml(camera.model)}<small>${escapeHtml(camera.shape)} · ${escapeHtml(camera.serial)}</small></td>
      <td><span class="dir-cell"><svg class="mini-arrow" viewBox="-10 -10 20 20" style="--dir:${camera.angle}deg" aria-hidden="true"><path d="M0-8 5 6 0 3-5 6z"/></svg>${compass(camera.angle)[1]} ${camera.angle}°</span><small>sudut ${camera.fov}°</small></td>
      <td class="mono">${escapeHtml(camera.ip || '—')}</td>
      <td>${!camera.ip ? '—' : !ping ? '<span class="muted">belum</span>' : ping.status === 'online' ? `${ping.latencyMs ?? '?'} ms` : '<span class="pill offline">timeout</span>'}<small>${ping ? relativeTime(ping.checkedAt) : ''}</small></td>
      <td><span class="status-label ${camera.status}">${statusText(camera.status)}</span></td>
      <td><div class="table-actions"><button class="table-button" data-action="locate" data-id="${escapeHtml(camera.id)}">Peta</button><button class="table-button" data-action="live" data-id="${escapeHtml(camera.id)}">Tayangan</button>${isAdmin() ? `<button class="table-button" data-action="edit" data-id="${escapeHtml(camera.id)}">Ubah</button>` : ''}</div></td>
    </tr>`;
  }).join('');
  $('#deviceEmpty').classList.toggle('hidden', list.length > 0);
}

/* ---------------------------------------------------------------- reports & history */

function renderReports() {
  const query = $('#reportSearch').value.trim().toLowerCase();
  const filter = state.reportFilter;
  const list = state.reports.filter((report) => {
    const text = `${report.id} ${report.cameraId} ${report.issue} ${report.note} ${report.reporter}`.toLowerCase();
    const statusOk = filter === 'all' || (filter === 'active' ? report.status !== 'resolved' : report.status === filter);
    return statusOk && (!query || text.includes(query));
  });
  $$('#reportTabs button').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.reportStatus === filter)));
  $('#reportList').innerHTML = list.map((report) => {
    const camera = cameraById(report.cameraId);
    const next = report.status === 'open' ? ['progress', 'Mulai kerjakan'] : report.status === 'progress' ? ['resolved', 'Selesaikan'] : ['open', 'Buka ulang'];
    return `<article class="report-item ${report.priority} ${report.status}">
      <div class="stack"><h3>${escapeHtml(report.id)}</h3><span class="pill ${report.status}">${reportStatusText(report.status)}</span></div>
      <div><p><strong>${escapeHtml(report.issue)}</strong> · <span class="mono">${escapeHtml(report.cameraId)}</span></p><small>${escapeHtml(camera ? `${camera.location} · ${FLOORS[camera.floor]}` : 'CCTV sudah dihapus')}</small><small>${escapeHtml(report.note)}</small></div>
      <div class="stack"><span class="pill ${report.priority === 'normal' ? 'normal-priority' : report.priority}">Prioritas ${priorityText(report.priority)}</span><small>${escapeHtml(report.reporter)} · ${formatDate(report.createdAt, true)}</small>${report.resolvedAt ? `<small>Selesai ${formatDate(report.resolvedAt, true)}</small>` : ''}</div>
      <div class="report-actions"><button class="table-button" data-report-action="locate" data-id="${escapeHtml(report.id)}" ${camera ? '' : 'disabled'}>Lihat CCTV</button>${isAdmin() ? `<button class="table-button" data-report-action="status" data-status="${next[0]}" data-id="${escapeHtml(report.id)}">${next[1]}</button>` : ''}</div>
    </article>`;
  }).join('');
  $('#reportEmpty').classList.toggle('hidden', list.length > 0);
}

function renderHistory() {
  const query = $('#historySearch').value.trim().toLowerCase();
  const list = state.history.filter((item) => `${item.actor} ${item.action} ${item.detail}`.toLowerCase().includes(query));
  $('#historyList').innerHTML = list.map((item) => `<article class="timeline-item ${item.actor === 'Sistem' ? 'system' : ''}"><time datetime="${item.createdAt}">${formatDate(item.createdAt, true)}</time><div><strong>${escapeHtml(item.action)}</strong><p>${escapeHtml(item.detail)} · ${escapeHtml(item.actor)}</p></div></article>`).join('');
  $('#historyEmpty').classList.toggle('hidden', list.length > 0);
}

/* ---------------------------------------------------------------- settings */

function renderCameraSelects() {
  const options = state.cameras.map((camera) => `<option value="${escapeHtml(camera.id)}">${escapeHtml(camera.id)} · ${escapeHtml(camera.location || camera.area)}</option>`).join('');
  for (const selector of ['#reportCamera', '#networkCamera']) {
    const select = $(selector);
    const value = select.value;
    select.innerHTML = options;
    if (state.cameras.some((camera) => camera.id === value)) select.value = value;
  }
  fillStreamForm();
}

function renderSettings() {
  // Map files
  $('#mapSettings').innerHTML = FLOOR_ORDER.map((floor) => {
    const info = state.settings.maps?.[floor] || { custom: false };
    return `<div class="map-setting"><div><strong>${FLOORS[floor]}</strong><small>${info.custom ? `SVG impor: ${escapeHtml(info.name || 'denah.svg')} · ${formatDate(info.uploadedAt, true)}` : 'Denah bawaan'}</small></div><button type="button" class="button small" data-map-upload="${floor}"><svg><use href="#i-upload"/></svg>Impor SVG</button>${info.custom ? `<button type="button" class="button small danger-soft" data-map-reset="${floor}">Pakai bawaan</button>` : ''}</div>`;
  }).join('');

  // NVR editor (do not clobber rows while an admin is typing)
  if (!$('#nvrForm').contains(document.activeElement)) {
    $('#nvrRows').innerHTML = '';
    (state.settings.nvrs || []).forEach((nvr) => addNvrRow(nvr));
    if (!state.settings.nvrs?.length) addNvrRow();
  }

  // Areas
  if (!$('#areaForm').contains(document.activeElement)) renderAreaTags(state.settings.areas || []);

  // Selects in device dialog and filters
  $('#formFloor').innerHTML = FLOOR_ORDER.map((floor) => `<option value="${floor}">${FLOORS[floor]}</option>`).join('');
  $('#deviceFloorFilter').innerHTML = `<option value="all">Semua lantai</option>${FLOOR_ORDER.map((floor) => `<option value="${floor}">${FLOORS[floor]}</option>`).join('')}`;
  $('#formNvr').innerHTML = `<option value="">Tidak ditentukan</option>${(state.settings.nvrs || []).map((nvr) => `<option value="${escapeHtml(nvr.id)}">${escapeHtml(nvr.name)} · ${escapeHtml(nvr.ip)}</option>`).join('')}`;
  renderNvrStatus();
}

function addNvrRow(nvr = { id: '', name: '', ip: '', location: '' }) {
  const row = document.createElement('tr');
  row.dataset.id = nvr.id || '';
  row.innerHTML = `<td><input data-field="name" value="${escapeHtml(nvr.name)}" placeholder="NVR Terminal 1" maxlength="60" aria-label="Nama NVR" /></td><td><input data-field="ip" class="mono" value="${escapeHtml(nvr.ip)}" placeholder="192.168.10.20" inputmode="decimal" aria-label="Alamat IP NVR" /></td><td><input data-field="location" value="${escapeHtml(nvr.location || '')}" placeholder="Ruang server" maxlength="80" aria-label="Lokasi NVR" /></td><td data-status-cell></td><td><button type="button" class="icon-button" data-remove-nvr aria-label="Hapus baris"><svg><use href="#i-trash"/></svg></button></td>`;
  $('#nvrRows').append(row);
}

let areaDraft = [];
function renderAreaTags(areas) {
  areaDraft = [...areas];
  $('#areaTags').innerHTML = areaDraft.map((area, index) => `<span class="tag">${escapeHtml(area)}<button type="button" data-remove-area="${index}" aria-label="Hapus ${escapeHtml(area)}"><svg><use href="#i-x"/></svg></button></span>`).join('');
}

function renderUsers() {
  const me = state.user?.id;
  $('#userList').innerHTML = state.users.map((user) => `<div class="user-row ${user.isActive ? '' : 'inactive'}"><span class="avatar">${escapeHtml(initials(user.name))}</span><span><strong>${escapeHtml(user.name)}${user.id === me ? ' (Anda)' : ''}</strong><small>${escapeHtml(user.email)} · ${user.role === 'admin' ? 'Administrator' : 'Operator'}${user.division ? ` · ${escapeHtml(user.division)}` : ''}${user.isActive ? '' : ' · nonaktif'}</small></span><span class="table-actions"><button class="table-button" data-user-edit="${user.id}">Ubah</button>${user.id === me ? '' : `<button class="table-button" data-user-toggle="${user.id}">${user.isActive ? 'Nonaktifkan' : 'Aktifkan'}</button><button class="table-button danger" data-user-delete="${user.id}">Hapus</button>`}</span></div>`).join('') || '<div class="empty-note">Belum ada akun.</div>';
}

function initials(name) {
  return String(name || '?').split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
}

function fillStreamForm() {
  const camera = cameraById($('#networkCamera').value) || state.cameras[0];
  if (!camera) return renderPingStatus(null);
  $('#networkCamera').value = camera.id;
  if (document.activeElement !== $('#cameraIp')) $('#cameraIp').value = camera.ip || '';
  $('#cameraStream').value = '';
  $('#cameraStream').placeholder = camera.hasStream ? 'Tersimpan terenkripsi — isi untuk mengganti' : 'rtsp://pengguna:sandi@192.168.1.64:554/…';
  $('#clearStream').checked = false;
  $('#clearStream').disabled = !camera.hasStream;
  renderPingStatus(camera.lastPing && camera.lastPing.ip === camera.ip ? camera.lastPing : null);
}

function renderPingStatus(result, detail = '') {
  const box = $('#cameraPingStatus');
  const state_ = result?.status || 'idle';
  box.dataset.state = state_;
  $('#cameraPingLabel').textContent = { idle: 'Belum diuji', loading: 'Menguji koneksi', online: 'Aktif', offline: 'Tidak merespons', invalid: 'Alamat IP tidak valid', error: 'Ping gagal' }[state_] || 'Belum diuji';
  if (state_ === 'online') $('#cameraPingDetail').textContent = `${result.ip} merespons dalam ${result.latencyMs ?? '?'} ms · ${formatDate(result.checkedAt, true)}.`;
  else if (state_ === 'offline') $('#cameraPingDetail').textContent = `${result.ip} tidak merespons · ${formatDate(result.checkedAt, true)}. Periksa daya, kabel PoE, VLAN/subnet, dan alamat IP.`;
  else $('#cameraPingDetail').textContent = detail || 'Simpan alamat IP lalu tekan Ping.';
}

/* ---------------------------------------------------------------- navigation */

const PAGE_META = {
  home: ['Ruang kontrol', 'Ringkasan'],
  map: ['Denah terminal', 'Peta CCTV'],
  devices: ['Inventaris', 'Perangkat CCTV'],
  reports: ['Operasional', 'Laporan gangguan'],
  history: ['Audit', 'Riwayat aktivitas'],
  settings: ['Administrator', 'Pengaturan sistem'],
};
const VIEW_KEYS = ['home', 'map', 'devices', 'reports', 'history', 'settings'];

function showView(view) {
  if (view === 'settings' && !isAdmin()) return toast('Pengaturan hanya untuk administrator.', { kind: 'error' });
  if (state.view === 'map' && view !== 'map') {
    setPlacing(false);
    flushSaves();
  }
  state.view = view;
  $$('.page-view').forEach((page) => page.classList.toggle('hidden', page.dataset.page !== view));
  $$('.nav-item[data-view]').forEach((button) => {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#pageContext').textContent = PAGE_META[view][0];
  $('#pageTitle').textContent = PAGE_META[view][1];
  if (view === 'map') requestAnimationFrame(layoutMap);
  if (view === 'devices') renderDeviceTable();
  if (view === 'reports') renderReports();
  if (view === 'history') renderHistory();
  if (view === 'settings') { renderSettings(); renderUsers(); }
  try { history.replaceState(null, '', `#${view}`); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------- dialogs */

function nextCameraId() {
  const max = state.cameras.reduce((result, camera) => Math.max(result, Number(camera.id.match(/(\d+)$/)?.[1] || 0)), 0);
  return `CCTV-T1-${String(max + 1).padStart(3, '0')}`;
}

function openDeviceDialog(id = null, preset = {}) {
  if (!isAdmin()) return toast('Hanya admin yang dapat mengubah perangkat.', { kind: 'error' });
  const camera = id ? cameraById(id) : null;
  $('#deviceForm').reset();
  $('#deviceMode').value = camera ? 'edit' : 'add';
  $('#deviceDialogTitle').textContent = camera ? `Ubah ${camera.id}` : 'Tambah CCTV';
  $('#formId').readOnly = Boolean(camera);
  $('#formId').value = camera?.id || nextCameraId();
  $('#formStatus').value = camera?.manualStatus || 'normal';
  const areas = [...(state.settings.areas || [])];
  if (camera?.area && !areas.includes(camera.area)) areas.unshift(camera.area);
  $('#formArea').innerHTML = `<option value="" disabled ${camera ? '' : 'selected'}>Pilih area</option>${areas.map((area) => `<option>${escapeHtml(area)}</option>`).join('')}`;
  if (camera) $('#formArea').value = camera.area;
  $('#formLocation').value = camera?.location || '';
  $('#formFloor').value = camera?.floor || preset.floor || state.floor;
  $('#formNvr').value = camera?.nvr || '';
  $('#formBrand').value = camera?.brand || '';
  $('#formModel').value = camera?.model || '';
  $('#formSerial').value = camera?.serial || '';
  $('#formInstalled').value = camera?.installed || new Date().toISOString().slice(0, 10);
  $('#formShape').value = camera?.shape || 'Dome';
  $('#formColor').value = camera?.color || 'Putih';
  $('#formIp').value = camera?.ip || '';
  $('#formStream').value = '';
  $('#formStream').placeholder = camera?.hasStream ? 'Tersimpan — isi untuk mengganti' : 'rtsp://pengguna:sandi@192.168.1.64:554/…';
  $('#formAngle').value = camera?.angle ?? 0;
  $('#formFov').value = camera?.fov ?? DEFAULT_FOV.Dome;
  $('#formX').value = camera?.x ?? preset.x ?? 50;
  $('#formY').value = camera?.y ?? preset.y ?? 50;
  $('#formNotes').value = camera?.notes || '';
  $('#deviceDialog').showModal();
  (camera ? $('#formLocation') : $('#formArea')).focus();
}

function openReportDialog(cameraId = '') {
  $('#reportForm').reset();
  renderCameraSelects();
  if (cameraId && cameraById(cameraId)) $('#reportCamera').value = cameraId;
  $('#reportTitle').textContent = cameraId ? `Laporkan ${cameraId}` : 'Buat laporan';
  const camera = cameraById(cameraId);
  if (camera?.status === 'offline') $('#reportIssue').value = 'Perangkat offline';
  $('#reportDialog').showModal();
  $('#reportNote').focus();
}

function openConfirm(title, message, actionLabel, callback) {
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#confirmAction').textContent = actionLabel;
  pendingConfirm = callback;
  $('#confirmDialog').showModal();
}

function openUserDialog(user = null) {
  $('#userForm').reset();
  $('#userId').value = user?.id || '';
  $('#userDialogTitle').textContent = user ? `Ubah ${user.email}` : 'Tambah akun';
  $('#userEmail').value = user?.email || '';
  $('#userEmail').readOnly = Boolean(user);
  $('#userName').value = user?.name || '';
  $('#userDivision').value = user?.division || '';
  $('#userRole').value = user?.role || 'operator';
  $('#userPassword').required = !user;
  $('#userPasswordHint').textContent = user ? '(kosongkan bila tidak direset)' : '(min. 12 karakter)';
  $('#userDialog').showModal();
}

function openSearch() {
  if (!state.user) return;
  $('#globalSearch').value = '';
  searchIndex = 0;
  renderSearchResults();
  $('#searchDialog').showModal();
  $('#globalSearch').focus();
}

function searchResults() {
  const query = $('#globalSearch').value.trim().toLowerCase();
  const list = state.cameras.filter((camera) => !query || `${camera.id} ${camera.area} ${camera.location} ${camera.brand} ${camera.model} ${camera.ip} ${camera.serial}`.toLowerCase().includes(query));
  return list.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id)).slice(0, 30);
}

function renderSearchResults() {
  const list = searchResults();
  searchIndex = Math.min(searchIndex, Math.max(0, list.length - 1));
  $('#globalResults').innerHTML = list.length ? list.map((camera, index) => `<li><button type="button" role="option" data-id="${escapeHtml(camera.id)}" aria-selected="${index === searchIndex}"><i class="status-dot ${camera.status}"></i><span><strong class="mono">${escapeHtml(camera.id)}</strong><small>${escapeHtml(camera.location)} · ${escapeHtml(camera.area)} · ${FLOORS[camera.floor]}</small></span><small class="mono">${escapeHtml(camera.ip || '')}</small></button></li>`).join('') : '<li class="empty-note">Tidak ada CCTV yang cocok.</li>';
  $('[aria-selected="true"]', $('#globalResults'))?.scrollIntoView({ block: 'nearest' });
}

/* ---------------------------------------------------------------- live view */

function openLive(id) {
  const camera = cameraById(id);
  if (!camera) return;
  liveCameraId = id;
  $('#liveCameraTitle').textContent = camera.id;
  $('#liveLocation').textContent = `${camera.area} · ${camera.location} · ${FLOORS[camera.floor]}`;
  $('#liveDirection').textContent = `Menghadap ${directionText(camera.angle)}`;
  $('#liveIp').textContent = camera.ip || 'IP belum diatur';
  const status = $('#liveStatus');
  status.className = `status-label ${camera.status}`;
  status.textContent = statusText(camera.status);
  $('#liveDialog').showModal();
  loadLiveStream();
  clearInterval(liveClockTimer);
  const update = () => { $('#liveClock').textContent = `${timeFormat.format(new Date())} WIB`; };
  update();
  liveClockTimer = setInterval(update, 1000);
}

function stopLivePlayback() {
  const video = $('#liveVideo');
  video.onloadeddata = null;
  video.onerror = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (livePlaybackUrl) fetch(livePlaybackUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
  livePlaybackUrl = null;
  $('#liveFrame').classList.remove('has-video');
}

async function loadLiveStream() {
  const camera = cameraById(liveCameraId);
  if (!camera) return;
  const requestId = ++liveRequestId;
  stopLivePlayback();
  if (!camera.hasStream) {
    $('#liveModeLabel').textContent = 'SIAGA';
    $('#liveFallbackText').textContent = isAdmin() ? 'URL RTSP belum diatur. Isi di Pengaturan › Tayangan kamera.' : 'URL tayangan belum diatur oleh administrator.';
    return;
  }
  $('#liveModeLabel').textContent = 'MENGHUBUNGKAN';
  $('#liveFallbackText').textContent = 'Menyiapkan tayangan dari server…';
  let playbackUrl;
  try {
    const data = await api('/api/streams', { method: 'POST', body: { cameraCode: camera.id } });
    if (requestId !== liveRequestId || !$('#liveDialog').open) {
      fetch(data.playbackUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
      return;
    }
    playbackUrl = data.playbackUrl;
  } catch (error) {
    if (requestId !== liveRequestId) return;
    $('#liveModeLabel').textContent = 'GAGAL';
    $('#liveFallbackText').textContent = error.message;
    return;
  }
  livePlaybackUrl = playbackUrl;
  const video = $('#liveVideo');
  video.onloadeddata = () => {
    if (requestId !== liveRequestId) return;
    $('#liveFrame').classList.add('has-video');
    video.play().catch(() => {});
  };
  video.onerror = () => {
    if (requestId !== liveRequestId) return;
    $('#liveFrame').classList.remove('has-video');
    $('#liveModeLabel').textContent = 'TERPUTUS';
    $('#liveFallbackText').textContent = 'Tayangan tidak dapat diputar. Periksa URL RTSP, kredensial, dan koneksi kamera, lalu tekan Muat ulang.';
  };
  video.src = playbackUrl;
  video.load();
}

function closeLive() {
  liveRequestId += 1;
  clearInterval(liveClockTimer);
  stopLivePlayback();
}

/* ---------------------------------------------------------------- session */

function setAuthError(message = '') {
  const box = $('#authError');
  box.classList.toggle('hidden', !message);
  $('span', box).textContent = message;
  if (message) box.focus();
}

async function enterApp(user) {
  state.user = user;
  state.loaded = false;
  $('#authScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  renderProfile();
  const hashView = location.hash.replace('#', '');
  showView(VIEW_KEYS.includes(hashView) && (hashView !== 'settings' || isAdmin()) ? hashView : 'home');
  setSync(false, 'Menyambung…');
  try {
    await loadAll();
  } catch (error) {
    reportError(error);
  }
  state.loaded = true;
  renderFloorPlan();
  connectEvents();
  clearInterval(clockTimer);
  tickClock();
  clockTimer = setInterval(() => {
    tickClock();
    if (Date.now() % 10000 < 1000) { renderMonitor(); if (state.selectedId) renderPingCard(cameraById(state.selectedId) || {}); }
  }, 1000);
}

function renderProfile() {
  const { name, role, division } = state.user;
  $('#profileName').textContent = name;
  $('#profileAvatar').textContent = initials(name);
  $('#roleName').textContent = `${role === 'admin' ? 'Administrator' : 'Operator'}${division ? ` · ${division}` : ''}`;
  $$('.admin-only').forEach((element) => element.classList.toggle('hidden', role !== 'admin'));
  if (role !== 'admin') {
    setEditMode(false);
    if (state.view === 'settings') showView('home');
  }
}

function resetSessionState() {
  events?.close();
  events = null;
  clearTimeout(eventsRetry);
  clearInterval(clockTimer);
  setEditMode(false);
  setPlacing(false);
  closeLive();
  $$('dialog[open]').forEach((dialog) => dialog.close());
  Object.assign(state, { user: null, cameras: [], reports: [], history: [], users: [], selectedId: null, loaded: false });
  pending.clear();
  undoStack.length = 0;
  $('#appShell').classList.add('hidden');
  $('#authScreen').classList.remove('hidden');
}

function sessionExpired() {
  if (!state.user) return;
  const email = state.user.email;
  resetSessionState();
  $('#loginEmail').value = email;
  setAuthError('Sesi Anda berakhir atau akun dinonaktifkan. Silakan masuk kembali.');
}

async function logout() {
  await flushSaves();
  const email = state.user?.email || '';
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  resetSessionState();
  $('#loginForm').reset();
  $('#loginEmail').value = email;
  setAuthError();
  $('#loginPassword').focus();
}

async function restoreSession() {
  applyTheme();
  applySound();
  applyLayers();
  state.floor = FLOORS[prefs.floor] ? prefs.floor : 'gf';
  try {
    const { user } = await api('/api/auth/session');
    if (user) return enterApp(user);
  } catch (error) {
    if (error.status === 503) setAuthError('Database server belum terhubung. Hubungi administrator.');
  }
  $('#authScreen').classList.remove('hidden');
  $('#appShell').classList.add('hidden');
  $('#loginEmail').focus();
}

/* =========================================================================
   Event wiring
   ========================================================================= */

// Navigation & top bar
$$('.nav-item[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('#globalSearchButton').addEventListener('click', openSearch);
$('#shortcutButton').addEventListener('click', () => $('#shortcutDialog').showModal());
$('#alarmPill').addEventListener('click', () => {
  state.statusFilter = 'offline';
  showView('map');
  const first = state.cameras.find((camera) => camera.status === 'offline');
  if (first && first.floor !== state.floor) setFloor(first.floor);
  syncChips();
  renderMarkers();
  renderList();
});
$('#themeToggle').addEventListener('click', () => {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
  savePrefs();
  applyTheme();
});
$('#soundToggle').addEventListener('click', () => {
  prefs.sound = !prefs.sound;
  savePrefs();
  applySound();
  if (prefs.sound) beep('recover');
});
$('#profileButton').addEventListener('click', () => {
  const user = state.user;
  $('#profileForm').reset();
  $('#accountName').value = user.name;
  $('#accountDivision').value = user.division;
  $('#accountEmail').value = user.email;
  $('#accountRole').value = user.role === 'admin' ? 'Administrator' : 'Operator';
  $('#profileDialog').showModal();
});
$('#logoutButton').addEventListener('click', logout);

// Dashboard
$('#viewAllIssues').addEventListener('click', () => showView('map'));
$('#viewAllReports').addEventListener('click', () => showView('reports'));
$('#viewAllHistory').addEventListener('click', () => showView('history'));
$('#dashboardAlerts').addEventListener('click', (event) => {
  const button = event.target.closest('[data-camera]');
  if (button) locateCamera(button.dataset.camera);
});
$('#floorBreakdown').addEventListener('click', (event) => {
  const button = event.target.closest('[data-floor-jump]');
  if (!button) return;
  showView('map');
  setFloor(button.dataset.floorJump);
});
$$('.kpi').forEach((kpi) => kpi.addEventListener('click', () => {
  const kind = kpi.dataset.kpi;
  if (kind === 'reports') return showView('reports');
  $('#deviceStatusFilter').value = kind === 'all' ? 'all' : kind;
  showView('devices');
}));
$('#dashRunMonitor').addEventListener('click', () => runMonitor($('#dashRunMonitor')));

async function runMonitor(button) {
  button.disabled = true;
  try {
    state.monitor = await api('/api/monitor/run', { method: 'POST' });
    renderMonitor();
    toast('Pemeriksaan jaringan selesai.');
  } catch (error) {
    reportError(error);
  } finally {
    button.disabled = false;
  }
}

// Map toolbar
$('#floorTabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-floor]');
  if (button) setFloor(button.dataset.floor);
});
$('#statusChips').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-status]');
  if (!chip) return;
  state.statusFilter = chip.dataset.status === state.statusFilter ? 'all' : chip.dataset.status;
  syncChips();
  renderMarkers();
  renderList();
});
$('#layerFov').addEventListener('change', (event) => { prefs.fov = event.target.checked; savePrefs(); applyLayers(); });
$('#layerLabels').addEventListener('change', (event) => { prefs.labels = event.target.checked; savePrefs(); applyLayers(); });
$('#editToggle').addEventListener('click', () => setEditMode(!state.editMode));
$('#addCamera').addEventListener('click', () => {
  setPlacing(!state.placing);
});
$('#addDeviceList').addEventListener('click', () => {
  showView('map');
  setPlacing(true);
});
$('#search').addEventListener('input', debounce(() => { renderMarkers(); renderList(); }, 120));

// Map surface
mapArea.addEventListener('pointerdown', startPan);
mapArea.addEventListener('pointermove', moveMap);
mapArea.addEventListener('pointerup', endPan);
mapArea.addEventListener('pointercancel', endPan);
mapArea.addEventListener('wheel', (event) => {
  event.preventDefault();
  zoomMap(Math.exp(-Math.max(-60, Math.min(60, event.deltaY)) * 0.006), event.clientX, event.clientY);
}, { passive: false });
cameraLayer.addEventListener('pointerdown', (event) => {
  const button = event.target.closest('.camera');
  if (!button) return;
  startMarkerDrag(event, button.closest('.camera-marker').dataset.id, button);
});
cameraLayer.addEventListener('click', (event) => {
  const button = event.target.closest('.camera');
  if (!button) return;
  event.stopPropagation();
  const id = button.closest('.camera-marker').dataset.id;
  if (state.placing) return;
  openDetail(id, { focus: false });
});
cameraLayer.addEventListener('pointerover', (event) => {
  const marker = event.target.closest('.camera-marker');
  if (marker && event.target.closest('.camera')) setHover(marker.dataset.id, event);
});
cameraLayer.addEventListener('pointerout', (event) => {
  if (event.target.closest('.camera') && !event.relatedTarget?.closest?.('.camera')) setHover(null);
});
$('#zoomIn').addEventListener('click', () => zoomMap(1.5));
$('#zoomOut').addEventListener('click', () => zoomMap(1 / 1.5));
$('#zoomFit').addEventListener('click', () => { fitMap(false); layoutMap(); });
$('#mapFullscreen').addEventListener('click', toggleMapFullscreen);
$('#minimap').addEventListener('pointerdown', (event) => {
  event.stopPropagation();
  minimapJump(event);
  const move = (moveEvent) => minimapJump(moveEvent);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});
$('#undoButton').addEventListener('click', undo);
new ResizeObserver(() => layoutMap()).observe(mapArea);
document.addEventListener('fullscreenchange', () => requestAnimationFrame(layoutMap));

function toggleMapFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else $('.map-stage').requestFullscreen?.().catch(() => toast('Layar penuh tidak diizinkan browser.', { kind: 'error' }));
}

// Side panel
$('#cameraList').addEventListener('click', (event) => {
  const row = event.target.closest('.camera-row');
  if (!row) return;
  const camera = cameraById(row.dataset.id);
  openDetail(row.dataset.id, { focus: false });
  focusCamera(camera);
});
$('#cameraList').addEventListener('mouseover', (event) => {
  const row = event.target.closest('.camera-row');
  if (row && row.dataset.id !== state.hoverId) setHover(row.dataset.id);
});
$('#cameraList').addEventListener('mouseleave', () => setHover(null));
$('#closeDetail').addEventListener('click', closeDetail);
$('#focusCamera').addEventListener('click', () => focusCamera(cameraById(state.selectedId)));
$('#liveView').addEventListener('click', () => openLive(state.selectedId));
$('#reportButton').addEventListener('click', () => openReportDialog(state.selectedId));
$('#editDevice').addEventListener('click', () => openDeviceDialog(state.selectedId));
$('#pingNow').addEventListener('click', async () => {
  const camera = cameraById(state.selectedId);
  if (!camera) return;
  const button = $('#pingNow');
  button.disabled = true;
  $('#pingCard').innerHTML = `<span class="ping-indicator" style="background:var(--warn)"></span><div>Menguji ${escapeHtml(camera.ip)}…</div>`;
  try {
    camera.lastPing = await api(`/api/cameras/${encodeURIComponent(camera.id)}/ping`, { method: 'POST' });
    renderPingCard(camera);
  } catch (error) {
    reportError(error);
    renderPingCard(camera);
  } finally {
    button.disabled = !camera.ip;
  }
});
$('#deleteDevice').addEventListener('click', () => {
  const camera = cameraById(state.selectedId);
  if (!camera) return;
  openConfirm(`Hapus ${camera.id}?`, `${camera.id} (${camera.location}) dan titiknya akan dihapus dari peta. Laporan lama tetap tersimpan di riwayat.`, 'Hapus CCTV', async () => {
    try {
      await api(`/api/cameras/${encodeURIComponent(camera.id)}`, { method: 'DELETE' });
      pending.delete(camera.id);
      closeDetail();
      await loadCameras();
      toast(`${camera.id} dihapus.`);
    } catch (error) {
      reportError(error);
    }
  });
});

// Direction editor
$('#dial').addEventListener('pointerdown', startDialDrag);
$('#dial').addEventListener('keydown', (event) => {
  const camera = cameraById(state.selectedId);
  if (!camera || !state.editMode) return;
  const step = event.shiftKey ? 15 : 5;
  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); editSelected({ angle: camera.angle + step }); }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); editSelected({ angle: camera.angle - step }); }
});
$('#angleInput').addEventListener('change', (event) => editSelected({ angle: Number(event.target.value) || 0 }));
$$('.cardinal-buttons button').forEach((button) => button.addEventListener('click', () => editSelected({ angle: Number(button.dataset.angle) })));
$('#fovInput').addEventListener('input', (event) => editSelected({ fov: Number(event.target.value) }));
$('#rangeInput').addEventListener('input', (event) => editSelected({ range: Number(event.target.value) }));
$('#positionX').addEventListener('change', (event) => editSelected({ x: Number(event.target.value) }));
$('#positionY').addEventListener('change', (event) => editSelected({ y: Number(event.target.value) }));

// Devices
$('#deviceSearch').addEventListener('input', debounce(renderDeviceTable, 120));
['#deviceStatusFilter', '#deviceFloorFilter', '#deviceAreaFilter'].forEach((selector) => $(selector).addEventListener('change', renderDeviceTable));
$$('.data-table th button[data-sort]').forEach((button) => button.addEventListener('click', () => {
  const key = button.dataset.sort;
  state.deviceSort = { key, dir: state.deviceSort.key === key ? -state.deviceSort.dir : 1 };
  renderDeviceTable();
}));
$('#deviceTable').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'locate') locateCamera(button.dataset.id);
  if (button.dataset.action === 'live') openLive(button.dataset.id);
  if (button.dataset.action === 'edit') openDeviceDialog(button.dataset.id);
});
$('#exportDevices').addEventListener('click', () => {
  downloadCsv('inventaris-cctv', [
    ['ID', 'Area', 'Lokasi', 'Lantai', 'Merek', 'Model', 'Nomor seri', 'Bentuk', 'Warna', 'IP', 'Arah (°)', 'Arah', 'Sudut pandang (°)', 'Status', 'Ping terakhir', 'Latensi (ms)', 'Dipasang', 'X (%)', 'Y (%)'],
    ...state.cameras.map((camera) => [camera.id, camera.area, camera.location, FLOORS[camera.floor], camera.brand, camera.model, camera.serial, camera.shape, camera.color, camera.ip, camera.angle, compass(camera.angle)[0], camera.fov, statusText(camera.status), camera.lastPing ? formatDate(camera.lastPing.checkedAt, true) : '', camera.lastPing?.latencyMs ?? '', camera.installed, camera.x, camera.y]),
  ]);
});

// Reports
$('#reportSearch').addEventListener('input', debounce(renderReports, 120));
$('#reportTabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-report-status]');
  if (!button) return;
  state.reportFilter = button.dataset.reportStatus;
  renderReports();
});
$('#newReportButton').addEventListener('click', () => openReportDialog());
$('#reportList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-report-action]');
  if (!button) return;
  const report = state.reports.find((item) => item.id === button.dataset.id);
  if (!report) return;
  if (button.dataset.reportAction === 'locate') return locateCamera(report.cameraId);
  button.disabled = true;
  try {
    await api(`/api/reports/${encodeURIComponent(report.id)}`, { method: 'PATCH', body: { status: button.dataset.status } });
    await Promise.all([loadReports(), loadCameras()]);
    toast(`${report.id}: ${reportStatusText(button.dataset.status)}`);
  } catch (error) {
    reportError(error);
    button.disabled = false;
  }
});

// History
$('#historySearch').addEventListener('input', debounce(renderHistory, 120));
$('#exportHistory').addEventListener('click', async () => {
  try {
    const rows = await api('/api/history?limit=2000');
    downloadCsv('riwayat-cctv', [['Waktu', 'Pengguna', 'Aktivitas', 'Detail'], ...rows.map((item) => [formatDate(item.createdAt, true), item.actor, item.action, item.detail])]);
  } catch (error) {
    reportError(error);
  }
});

// Settings
$('#monitorForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/settings/monitor', { method: 'PUT', body: { intervalSec: Number($('#monitorInterval').value) } });
    await loadMonitor();
    toast('Interval pemantauan disimpan.');
  } catch (error) {
    reportError(error);
  }
});
$('#runMonitor').addEventListener('click', () => runMonitor($('#runMonitor')));
let mapUploadFloor = 'gf';
$('#mapSettings').addEventListener('click', (event) => {
  const upload = event.target.closest('[data-map-upload]');
  const reset = event.target.closest('[data-map-reset]');
  if (upload) {
    mapUploadFloor = upload.dataset.mapUpload;
    $('#mapFile').click();
  }
  if (reset) {
    const floor = reset.dataset.mapReset;
    openConfirm(`Pakai denah bawaan ${FLOORS[floor].toLowerCase()}?`, 'SVG impor dilepas untuk semua komputer. Posisi CCTV tidak berubah.', 'Pakai bawaan', async () => {
      try {
        await api(`/api/maps/${floor}`, { method: 'DELETE' });
        await loadSettings();
        toast('Denah bawaan dipakai.');
      } catch (error) {
        reportError(error);
      }
    });
  }
});
$('#mapFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.svg')) return toast('Pilih file SVG.', { kind: 'error' });
  try {
    const svg = sanitizeSvg(await file.text());
    await api(`/api/maps/${mapUploadFloor}?name=${encodeURIComponent(file.name)}`, { method: 'PUT', body: svg, headers: { 'Content-Type': 'image/svg+xml' } });
    await loadSettings();
    toast(`Denah ${FLOORS[mapUploadFloor].toLowerCase()} diperbarui untuk semua komputer.`);
  } catch (error) {
    reportError(error);
  }
});
$('#addNvrRow').addEventListener('click', () => { addNvrRow(); $('#nvrRows tr:last-child input')?.focus(); });
$('#nvrRows').addEventListener('click', (event) => {
  if (event.target.closest('[data-remove-nvr]')) event.target.closest('tr').remove();
});
$('#nvrForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const nvrs = $$('#nvrRows tr').map((row) => ({
    id: row.dataset.id || undefined,
    name: $('[data-field="name"]', row).value.trim(),
    ip: $('[data-field="ip"]', row).value.trim(),
    location: $('[data-field="location"]', row).value.trim(),
  })).filter((nvr) => nvr.name || nvr.ip);
  try {
    document.activeElement?.blur();
    await api('/api/settings/nvrs', { method: 'PUT', body: { nvrs } });
    await loadSettings();
    toast(`${nvrs.length} NVR disimpan. Monitor memeriksa sekarang.`);
  } catch (error) {
    reportError(error);
  }
});
$('#networkCamera').addEventListener('change', fillStreamForm);
$('#pingCamera').addEventListener('click', async () => {
  const camera = cameraById($('#networkCamera').value);
  if (!camera) return;
  if ($('#cameraIp').value.trim() !== (camera.ip || '')) return renderPingStatus({ status: 'invalid' }, 'Simpan alamat IP baru terlebih dahulu, lalu ping.');
  if (!camera.ip) return renderPingStatus({ status: 'invalid' }, 'CCTV ini belum memiliki alamat IP.');
  const button = $('#pingCamera');
  button.disabled = true;
  renderPingStatus({ status: 'loading' }, `Menguji ${camera.ip}…`);
  try {
    camera.lastPing = await api(`/api/cameras/${encodeURIComponent(camera.id)}/ping`, { method: 'POST' });
    renderPingStatus(camera.lastPing);
  } catch (error) {
    renderPingStatus({ status: 'error' }, error.message);
  } finally {
    button.disabled = false;
  }
});
$('#streamForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const camera = cameraById($('#networkCamera').value);
  if (!camera) return;
  const body = { ip: $('#cameraIp').value.trim() };
  const streamUrl = $('#cameraStream').value.trim();
  if (streamUrl) body.streamUrl = streamUrl;
  if ($('#clearStream').checked) body.clearStream = true;
  try {
    await api(`/api/cameras/${encodeURIComponent(camera.id)}`, { method: 'PATCH', body });
    $('#cameraStream').value = '';
    await loadCameras();
    toast(`Konfigurasi ${camera.id} disimpan.`);
  } catch (error) {
    reportError(error);
  }
});
$('#addArea').addEventListener('click', () => {
  const value = $('#areaInput').value.trim();
  if (!value) return;
  if (!areaDraft.includes(value)) areaDraft.push(value);
  $('#areaInput').value = '';
  renderAreaTags(areaDraft);
  $('#areaInput').focus();
});
$('#areaInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); $('#addArea').click(); }
});
$('#areaTags').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-area]');
  if (!button) return;
  areaDraft.splice(Number(button.dataset.removeArea), 1);
  renderAreaTags(areaDraft);
});
$('#areaForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    document.activeElement?.blur();
    await api('/api/settings/areas', { method: 'PUT', body: { areas: areaDraft } });
    await loadSettings();
    toast('Daftar area disimpan.');
  } catch (error) {
    reportError(error);
  }
});
$('#addUser').addEventListener('click', () => openUserDialog());
$('#userList').addEventListener('click', (event) => {
  const edit = event.target.closest('[data-user-edit]');
  const toggle = event.target.closest('[data-user-toggle]');
  const remove = event.target.closest('[data-user-delete]');
  const id = (edit || toggle || remove)?.dataset.userEdit || (edit || toggle || remove)?.dataset.userToggle || (edit || toggle || remove)?.dataset.userDelete;
  const user = state.users.find((item) => item.id === id);
  if (!user) return;
  if (edit) openUserDialog(user);
  if (toggle) {
    api(`/api/users/${user.id}`, { method: 'PATCH', body: { isActive: !user.isActive } })
      .then(() => { loadUsers(); toast(`${user.email} ${user.isActive ? 'dinonaktifkan' : 'diaktifkan'}.`); })
      .catch(reportError);
  }
  if (remove) {
    openConfirm(`Hapus akun ${user.email}?`, 'Akun tidak dapat dipulihkan. Riwayat aktivitasnya tetap ada tanpa nama pelaku. Pertimbangkan Nonaktifkan.', 'Hapus akun', async () => {
      try {
        await api(`/api/users/${user.id}`, { method: 'DELETE' });
        await loadUsers();
        toast('Akun dihapus.');
      } catch (error) {
        reportError(error);
      }
    });
  }
});
$('#userForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#userId').value;
  const body = { name: $('#userName').value.trim(), division: $('#userDivision').value.trim(), role: $('#userRole').value };
  const password = $('#userPassword').value;
  try {
    if (id) {
      if (password) body.password = password;
      await api(`/api/users/${id}`, { method: 'PATCH', body });
    } else {
      await api('/api/users', { method: 'POST', body: { ...body, email: $('#userEmail').value.trim(), password } });
    }
    $('#userDialog').close();
    await loadUsers();
    toast(id ? 'Akun diperbarui.' : 'Akun dibuat. Berikan kata sandi awal kepada petugas secara langsung.');
  } catch (error) {
    reportError(error);
  }
});

// Device dialog
$('#formShape').addEventListener('change', () => {
  if ($('#deviceMode').value === 'add') $('#formFov').value = DEFAULT_FOV[$('#formShape').value] || 90;
});
$('#deviceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const mode = $('#deviceMode').value;
  const id = $('#formId').value.trim().toUpperCase();
  const body = {
    status: $('#formStatus').value,
    area: $('#formArea').value,
    location: $('#formLocation').value.trim(),
    floor: $('#formFloor').value,
    nvr: $('#formNvr').value,
    brand: $('#formBrand').value.trim(),
    model: $('#formModel').value.trim(),
    serial: $('#formSerial').value.trim(),
    installed: $('#formInstalled').value,
    shape: $('#formShape').value,
    color: $('#formColor').value.trim(),
    ip: $('#formIp').value.trim(),
    angle: Number($('#formAngle').value),
    fov: Number($('#formFov').value),
    x: Number($('#formX').value),
    y: Number($('#formY').value),
    notes: $('#formNotes').value.trim(),
  };
  const streamUrl = $('#formStream').value.trim();
  if (streamUrl) body.streamUrl = streamUrl;
  if (!body.area) return toast('Pilih area CCTV.', { kind: 'error' });
  const submit = $('#deviceSubmit');
  submit.disabled = true;
  try {
    if (mode === 'add') await api('/api/cameras', { method: 'POST', body: { id, ...body } });
    else {
      pending.delete(id);
      await api(`/api/cameras/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    }
    $('#deviceDialog').close();
    await loadCameras();
    if (state.view === 'map' || mode === 'add') {
      showView('map');
      openDetail(id);
      if (mode === 'add') {
        setEditMode(true);
        toast('Seret ujung kerucut biru di peta untuk mengatur arah dan jangkauan.', { title: `${id} ditambahkan`, duration: 7000 });
      }
    }
    if (mode !== 'add') toast(`${id} diperbarui.`);
  } catch (error) {
    reportError(error);
  } finally {
    submit.disabled = false;
  }
});

// Report dialog
$('#reportForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const report = await api('/api/reports', { method: 'POST', body: { cameraCode: $('#reportCamera').value, issue: $('#reportIssue').value, priority: $('#reportPriority').value, note: $('#reportNote').value.trim() } });
    $('#reportDialog').close();
    await Promise.all([loadReports(), loadCameras()]);
    toast(`${report.id} terkirim ke semua petugas.`);
  } catch (error) {
    reportError(error);
  }
});

// Profile dialog
$('#profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = { name: $('#accountName').value.trim(), division: $('#accountDivision').value.trim() };
  if ($('#newPassword').value) Object.assign(body, { currentPassword: $('#currentPassword').value, newPassword: $('#newPassword').value });
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body });
    state.user = { ...state.user, name: user.name, division: user.division };
    renderProfile();
    $('#profileDialog').close();
    toast(body.newPassword ? 'Kata sandi diganti. Sesi di komputer lain diakhiri.' : 'Profil diperbarui.');
  } catch (error) {
    reportError(error);
  }
});

// Confirm
$('#confirmForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const callback = pendingConfirm;
  pendingConfirm = null;
  $('#confirmDialog').close();
  callback?.();
});

// Live
$('#refreshLive').addEventListener('click', loadLiveStream);
$('#fullscreenLive').addEventListener('click', () => $('#liveFrame').requestFullscreen?.());
$('#liveDialog').addEventListener('close', closeLive);

// Global search
$('#globalSearch').addEventListener('input', () => { searchIndex = 0; renderSearchResults(); });
$('#globalSearch').addEventListener('keydown', (event) => {
  const list = searchResults();
  if (event.key === 'ArrowDown') { event.preventDefault(); searchIndex = Math.min(list.length - 1, searchIndex + 1); renderSearchResults(); }
  if (event.key === 'ArrowUp') { event.preventDefault(); searchIndex = Math.max(0, searchIndex - 1); renderSearchResults(); }
  if (event.key === 'Enter' && list[searchIndex]) { event.preventDefault(); $('#searchDialog').close(); locateCamera(list[searchIndex].id); }
});
$('#globalResults').addEventListener('click', (event) => {
  const button = event.target.closest('[data-id]');
  if (!button) return;
  $('#searchDialog').close();
  locateCamera(button.dataset.id);
});
$('#searchDialog').addEventListener('click', (event) => { if (event.target === $('#searchDialog')) $('#searchDialog').close(); });

// Dialog close buttons
$$('[data-close]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));

// Login
$('#togglePassword').addEventListener('click', () => {
  const input = $('#loginPassword');
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  $('#togglePassword').textContent = reveal ? 'Sembunyi' : 'Lihat';
  $('#togglePassword').setAttribute('aria-label', reveal ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
});
['#loginEmail', '#loginPassword'].forEach((selector) => $(selector).addEventListener('input', () => {
  $(selector).removeAttribute('aria-invalid');
  $(selector === '#loginEmail' ? '#emailError' : '#passwordError').textContent = '';
  setAuthError();
}));
$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const emailInput = $('#loginEmail');
  const passwordInput = $('#loginPassword');
  const email = emailInput.value.trim().toLowerCase();
  let valid = true;
  setAuthError();
  if (!email || !emailInput.validity.valid) {
    emailInput.setAttribute('aria-invalid', 'true');
    $('#emailError').textContent = 'Masukkan alamat email yang valid.';
    valid = false;
  }
  if (!passwordInput.value) {
    passwordInput.setAttribute('aria-invalid', 'true');
    $('#passwordError').textContent = 'Masukkan kata sandi.';
    valid = false;
  }
  if (!valid) return (emailInput.getAttribute('aria-invalid') ? emailInput : passwordInput).focus();
  const button = $('#loginButton');
  button.disabled = true;
  button.textContent = 'Memeriksa…';
  try {
    const { user } = await api('/api/auth/login', { method: 'POST', body: { email, password: passwordInput.value } });
    $('#loginForm').reset();
    passwordInput.type = 'password';
    $('#togglePassword').textContent = 'Lihat';
    await enterApp(user);
  } catch (error) {
    passwordInput.setAttribute('aria-invalid', 'true');
    setAuthError(error.status === 401 ? 'Periksa kembali email dan kata sandi, lalu coba lagi.' : error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Masuk';
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', (event) => {
  if (!state.user) return;
  const typing = event.target.closest?.('input, textarea, select, [contenteditable="true"]');
  const dialogOpen = Boolean($('dialog[open]'));
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    return openSearch();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && state.editMode && !typing && !dialogOpen) {
    event.preventDefault();
    return undo();
  }
  if (typing || dialogOpen || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key;
  if (key === '/') { event.preventDefault(); return openSearch(); }
  if (key === '?') return $('#shortcutDialog').showModal();
  if (/^[1-6]$/.test(key)) return showView(VIEW_KEYS[Number(key) - 1]);
  if (key === 'Escape') {
    if (state.placing) return setPlacing(false);
    if (state.selectedId) return closeDetail();
    if (state.editMode) return setEditMode(false);
  }
  if (state.view !== 'map') return;
  if (key === '+' || key === '=') return zoomMap(1.4);
  if (key === '-' || key === '_') return zoomMap(1 / 1.4);
  if (key === '0') { fitMap(false); return layoutMap(); }
  if (key.toLowerCase() === 'f') return toggleMapFullscreen();
  if (key.toLowerCase() === 'g') return setFloor(FLOOR_ORDER[(FLOOR_ORDER.indexOf(state.floor) + 1) % FLOOR_ORDER.length]);
  if (key.toLowerCase() === 'n') return stepSelection(1);
  if (key.toLowerCase() === 'p') return stepSelection(-1);
  if (key.toLowerCase() === 'e' && isAdmin()) return setEditMode(!state.editMode);
  const camera = cameraById(state.selectedId);
  if (!state.editMode || !camera) return;
  const big = event.shiftKey;
  const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (moves[key]) {
    event.preventDefault();
    const step = big ? 0.5 : 0.05;
    return editSelected({ x: camera.x + moves[key][0] * step, y: camera.y + moves[key][1] * step });
  }
  const lower = key.toLowerCase();
  if (lower === 'q') return editSelected({ angle: camera.angle - (big ? 15 : 5) });
  if (lower === 'w') return editSelected({ angle: camera.angle + (big ? 15 : 5) });
  if (key === '[' || key === '{') return editSelected({ fov: camera.fov - 5 });
  if (key === ']' || key === '}') return editSelected({ fov: camera.fov + 5 });
  if (key === ',' || key === '<') return editSelected({ range: camera.range - 0.2 });
  if (key === '.' || key === '>') return editSelected({ range: camera.range + 0.2 });
});

window.addEventListener('beforeunload', () => {
  if (pending.size) flushSaves();
});

// Dial tick marks
$('#dialTicks').innerHTML = Array.from({ length: 24 }, (_, index) => {
  const angle = index * 15;
  const major = angle % 45 === 0;
  const radians = (angle * Math.PI) / 180;
  const inner = major ? 47 : 50;
  return `<line class="${major ? 'major' : ''}" x1="${(Math.sin(radians) * inner).toFixed(2)}" y1="${(-Math.cos(radians) * inner).toFixed(2)}" x2="${(Math.sin(radians) * 54).toFixed(2)}" y2="${(-Math.cos(radians) * 54).toFixed(2)}"/>`;
}).join('');

restoreSession();
