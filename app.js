const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const STORAGE_KEY = 'cctv-map-state-v2';
const SESSION_KEY = 'cctv-map-session';
const ACCOUNTS = [
  { email: 'admin@airport.local', passwordHash: '3eb3fe66b31e3b4d10fa70b5cad49c7112294af6ae4e476a1c405155d45aa121', name: 'Adi Rachman', role: 'admin', division: 'Teknologi Informasi' },
  { email: 'user@airport.local', passwordHash: 'bc5848f227cc161eb5f68dfe98cb13110a9c843ce69e953a88107d865583d397', name: 'Nadia Putri', role: 'user', division: 'Operasional' }
];

const defaultCameras = [
  { id: 'CCTV-T1-021', area: 'Koridor utama', location: 'Dekat Gate B3', brand: 'Hikvision', model: 'DS-2CD2143G2-I', serial: 'HKV-T1-0021', color: 'Putih', shape: 'Dome', installed: '2024-03-12', ip: '192.168.10.121', streamUrl: '', angle: 315, status: 'normal', x: 51, y: 37, updated: '4 menit lalu' },
  { id: 'CCTV-T1-007', area: 'Ruang operasi', location: 'Pintu masuk ruang operasi', brand: 'Dahua', model: 'IPC-HDBW2431E', serial: 'DHA-T1-0007', color: 'Putih', shape: 'Dome', installed: '2024-01-28', ip: '192.168.10.107', streamUrl: '', angle: 180, status: 'normal', x: 26, y: 25, updated: '8 menit lalu' },
  { id: 'CCTV-T1-013', area: 'Gate B1–B6', location: 'Area tunggu Gate B4', brand: 'Hikvision', model: 'DS-2CD2143G2-I', serial: 'HKV-T1-0013', color: 'Putih', shape: 'Dome', installed: '2024-02-06', ip: '192.168.10.113', streamUrl: '', angle: 90, status: 'warning', x: 76, y: 27, updated: 'Gangguan 12 menit lalu' },
  { id: 'CCTV-T1-016', area: 'Koridor utama', location: 'Akses menuju bagasi', brand: 'Dahua', model: 'IPC-HDW2431T-AS', serial: 'DHA-T1-0016', color: 'Putih', shape: 'Bullet', installed: '2023-11-21', ip: '192.168.10.116', streamUrl: '', angle: 180, status: 'offline', x: 51, y: 64, updated: 'Offline sejak 09:42' },
  { id: 'CCTV-T1-019', area: 'Area bagasi', location: 'Belt bagasi 2', brand: 'Hikvision', model: 'DS-2CD2143G2-I', serial: 'HKV-T1-0019', color: 'Putih', shape: 'Dome', installed: '2024-03-10', ip: '192.168.10.119', streamUrl: '', angle: 45, status: 'warning', x: 26, y: 76, updated: 'Gangguan 21 menit lalu' },
  { id: 'CCTV-T1-024', area: 'Lounge dan kafe', location: 'Akses masuk kafe', brand: 'Dahua', model: 'IPC-HDBW2431E', serial: 'DHA-T1-0024', color: 'Putih', shape: 'Dome', installed: '2024-04-18', ip: '192.168.10.124', streamUrl: '', angle: 270, status: 'normal', x: 77, y: 76, updated: '6 menit lalu' }
];

const defaultReports = [
  { id: 'RPT-2026-001', cameraId: 'CCTV-T1-016', issue: 'Perangkat offline', priority: 'critical', note: 'Tidak merespons ping dari ruang kontrol.', status: 'progress', reporter: 'Raka / TI', createdAt: '2026-10-04T09:42:00+07:00' },
  { id: 'RPT-2026-002', cameraId: 'CCTV-T1-019', issue: 'Gambar tidak jelas', priority: 'high', note: 'Gambar buram pada sisi kanan.', status: 'open', reporter: 'Nadia / Operasional', createdAt: '2026-10-04T10:03:00+07:00' },
  { id: 'RPT-2026-003', cameraId: 'CCTV-T1-013', issue: 'Arah kamera berubah', priority: 'normal', note: 'Sudut tidak lagi mencakup antrean Gate B4.', status: 'open', reporter: 'Bima / Keamanan', createdAt: '2026-10-04T10:12:00+07:00' }
];

const defaultHistory = [
  { id: 'H-005', createdAt: '2026-10-04T10:12:00+07:00', actor: 'Bima', action: 'Membuat laporan', detail: 'Arah CCTV-T1-013 berubah' },
  { id: 'H-004', createdAt: '2026-10-04T10:03:00+07:00', actor: 'Nadia', action: 'Membuat laporan', detail: 'Gambar CCTV-T1-019 tidak jelas' },
  { id: 'H-003', createdAt: '2026-10-04T09:48:00+07:00', actor: 'Adi Rachman', action: 'Memulai perbaikan', detail: 'CCTV-T1-016' },
  { id: 'H-002', createdAt: '2026-10-04T09:42:00+07:00', actor: 'Sistem', action: 'Status berubah', detail: 'CCTV-T1-016 menjadi offline' },
  { id: 'H-001', createdAt: '2026-10-03T16:20:00+07:00', actor: 'Adi Rachman', action: 'Memperbarui arah', detail: 'CCTV-T1-021 menjadi 315°' }
];

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved) return saved;
  } catch (error) {
    console.warn('Data lokal tidak dapat dibaca', error);
  }
  return null;
}

function dateToISO(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value;
  const months = { Januari: '01', Februari: '02', Maret: '03', April: '04', Mei: '05', Juni: '06', Juli: '07', Agustus: '08', September: '09', Oktober: '10', November: '11', Desember: '12' };
  const match = String(value || '').match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  return match && months[match[2]] ? `${match[3]}-${months[match[2]]}-${match[1].padStart(2, '0')}` : '2024-01-01';
}

function migrateCamera(camera, index) {
  const deviceParts = String(camera.device || '').split(' ');
  const physicalParts = String(camera.color || '').split(/[·,]/).map((part) => part.trim());
  return {
    id: camera.id || `CCTV-T1-${String(index + 1).padStart(3, '0')}`,
    area: camera.area || 'Area belum ditentukan',
    location: camera.location || 'Lokasi belum diisi',
    brand: camera.brand || deviceParts.shift() || 'Belum diisi',
    model: camera.model || deviceParts.join(' ') || 'Belum diisi',
    serial: camera.serial || `SN-${String(index + 1).padStart(4, '0')}`,
    color: camera.brand ? camera.color : physicalParts[0] || 'Belum diisi',
    shape: camera.shape || physicalParts[1] || 'Dome',
    installed: dateToISO(camera.installed),
    ip: camera.ip || '',
    streamUrl: camera.streamUrl || '',
    angle: Number.isFinite(camera.angle) ? camera.angle : Number(camera.direction?.match(/(\d+)°/)?.[1] || 0),
    status: camera.status || 'normal',
    x: Number(camera.x) || 50,
    y: Number(camera.y) || 50,
    updated: camera.updated || 'Baru diperbarui'
  };
}

const savedState = loadState();
let legacyCameras = null;
try { legacyCameras = JSON.parse(localStorage.getItem('cctv-map-cameras') || 'null'); } catch (error) { legacyCameras = null; }

let cameras = (savedState?.cameras || legacyCameras || defaultCameras).map(migrateCamera);
let reports = savedState?.reports || defaultReports;
let historyItems = savedState?.history || defaultHistory;
let settings = savedState?.settings || {
  profile: { name: 'Adi Rachman', email: 'admin@airport.local', role: 'admin', division: 'Teknologi Informasi' },
  nvrAddress: 'http://192.168.10.20',
  networkStatus: 'unknown',
  networkCheckedAt: '',
  customMap: ''
};
settings.profile = { email: 'admin@airport.local', ...settings.profile };

let selectedId = null;
let activeView = 'home';
let editMode = false;
let pendingConfirm = null;
let liveCameraId = null;
let liveClockTimer = null;
let toastTimer = null;

const cameraLayer = $('#cameraLayer');
const mapArea = $('#mapArea');
const directionRange = $('#directionRange');
const defaultMapMarkup = $('#floorPlanHost').innerHTML;

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ cameras, reports, history: historyItems, settings }));
}

function isAdmin() {
  return settings.profile.role === 'admin';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function formatDate(value, includeTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || 'Belum ada';
  return new Intl.DateTimeFormat('id-ID', includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'long' }).format(date);
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

function directionText(angle) {
  const names = ['Utara', 'Timur laut', 'Timur', 'Tenggara', 'Selatan', 'Barat daya', 'Barat', 'Barat laut'];
  return `${names[Math.round(((angle % 360) / 45)) % 8]} · ${angle}°`;
}

function cameraIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 8.5h11.7l4.8-2.9v12.8l-4.8-2.9H3.5z"/><path d="M7 8.5V6.4h5.3v2.1"/></svg>';
}

function addHistory(action, detail, actor = settings.profile.name) {
  historyItems.unshift({ id: `H-${Date.now()}`, createdAt: new Date().toISOString(), actor, action, detail });
  historyItems = historyItems.slice(0, 250);
  saveState();
  renderHistory();
  renderDashboard();
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function renderFloorPlan() {
  const host = $('#floorPlanHost');
  host.innerHTML = settings.customMap || defaultMapMarkup;
  const svg = host.querySelector('svg');
  if (svg) {
    svg.classList.add('floor-plan');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Denah bandara');
  }
  $('#mapSourceLabel').textContent = settings.customMap ? 'SVG impor' : 'Denah bawaan';
}

function renderCameras() {
  const query = $('#search').value.trim().toLowerCase();
  const filter = $('#mapStatusFilter').value;
  cameraLayer.innerHTML = '';

  cameras.forEach((camera) => {
    const haystack = `${camera.id} ${camera.area} ${camera.location} ${camera.brand} ${camera.model}`.toLowerCase();
    if ((query && !haystack.includes(query)) || (filter !== 'all' && camera.status !== filter)) return;

    const marker = document.createElement('div');
    marker.className = `camera-marker status-${camera.status}${selectedId === camera.id ? ' selected' : ''}`;
    marker.style.left = `${camera.x}%`;
    marker.style.top = `${camera.y}%`;
    marker.style.setProperty('--dir', `${camera.angle}deg`);
    marker.dataset.id = camera.id;

    const field = document.createElement('span');
    field.className = 'camera-fov';
    field.setAttribute('aria-hidden', 'true');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'camera';
    button.innerHTML = cameraIcon();
    button.setAttribute('aria-label', `${camera.id}, ${statusText(camera.status)}, arah ${directionText(camera.angle)}`);
    button.addEventListener('click', () => openDetail(camera.id));
    button.addEventListener('pointerdown', startDrag);
    marker.append(field, button);
    cameraLayer.append(marker);
  });
  updateSummary();
}

function updateSummary() {
  const counts = cameras.reduce((result, camera) => ({ ...result, [camera.status]: (result[camera.status] || 0) + 1 }), {});
  $('#totalCount').textContent = cameras.length;
  $('#healthyCount').textContent = counts.normal || 0;
  $('#warningCount').textContent = counts.warning || 0;
  $('#offlineCount').textContent = counts.offline || 0;
  const activeReports = reports.filter((report) => report.status !== 'resolved').length;
  $('#reportBadge').textContent = activeReports;
  $('#reportBadge').classList.toggle('hidden', activeReports === 0);
  $('#activeReportText').textContent = `${activeReports} laporan aktif`;
  $('#lastUpdated').textContent = `Diperbarui ${new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' }).format(new Date())} WIB`;
}

function renderDashboard() {
  const counts = cameras.reduce((result, camera) => ({ ...result, [camera.status]: (result[camera.status] || 0) + 1 }), {});
  const normal = counts.normal || 0;
  const issues = cameras.filter((camera) => camera.status !== 'normal').sort((a, b) => (a.status === 'offline' ? -1 : 1) - (b.status === 'offline' ? -1 : 1));
  const activeReports = reports.filter((report) => report.status !== 'resolved');
  const criticalReports = activeReports.filter((report) => report.priority === 'critical').length;
  const health = cameras.length ? Math.round((normal / cameras.length) * 100) : 0;
  const areas = new Set(cameras.map((camera) => camera.area)).size;

  $('#dashTotal').textContent = cameras.length;
  $('#dashCoverage').textContent = `${areas} area dipantau`;
  $('#dashHealth').textContent = `${health}%`;
  $('#dashHealthBar').style.width = `${health}%`;
  $('#dashIssues').textContent = issues.length;
  $('#dashReports').textContent = activeReports.length;
  $('#dashCritical').textContent = `${criticalReports} prioritas kritis`;

  $('#dashboardAlerts').innerHTML = issues.length ? `<div class="dashboard-list">${issues.slice(0, 5).map((camera) => `<div class="dashboard-list-item"><button type="button" data-dashboard-camera="${camera.id}"><strong>${escapeHtml(camera.id)}</strong><small>${escapeHtml(camera.location)} · ${escapeHtml(camera.updated)}</small></button><span class="state-pill ${camera.status}">${escapeHtml(statusText(camera.status))}</span></div>`).join('')}</div>` : '<div class="dashboard-empty">Semua CCTV beroperasi normal.</div>';

  const total = Math.max(cameras.length, 1);
  $('#statusBreakdown').innerHTML = ['normal', 'warning', 'offline'].map((status) => {
    const value = counts[status] || 0;
    return `<div class="breakdown-row"><span><i class="status-dot ${status}"></i>${escapeHtml(statusText(status))}</span><div class="breakdown-bar"><i class="${status}" style="width:${(value / total) * 100}%"></i></div><b>${value}</b></div>`;
  }).join('');

  $('#dashboardReports').innerHTML = reports.length ? `<div class="dashboard-list">${reports.slice(0, 4).map((report) => `<div class="dashboard-list-item"><button type="button" data-dashboard-report="${report.id}"><strong>${escapeHtml(report.issue)}</strong><small>${escapeHtml(report.cameraId)} · ${escapeHtml(formatDate(report.createdAt, true))}</small></button><span class="state-pill ${report.status}">${escapeHtml(reportStatusText(report.status))}</span></div>`).join('')}</div>` : '<div class="dashboard-empty">Belum ada laporan.</div>';

  const networkLabels = { unknown: 'Belum diuji', connected: 'Terhubung', offline: 'Tidak terhubung' };
  $('#dashNetwork').textContent = networkLabels[settings.networkStatus] || networkLabels.unknown;
  $('#dashMapSource').textContent = settings.customMap ? 'SVG impor' : 'Denah bawaan';
  $('#dashLastActivity').textContent = historyItems[0] ? formatDate(historyItems[0].createdAt, true) : 'Belum ada';
}

function openDetail(id, shouldRender = true) {
  const camera = cameras.find((item) => item.id === id);
  if (!camera) return;
  selectedId = id;
  $('#emptyState').classList.add('hidden');
  $('#detailContent').classList.remove('hidden');
  $('#detailArea').textContent = camera.area;
  $('#detailId').textContent = camera.id;
  $('#detailLocation').textContent = camera.location;
  $('#detailDevice').textContent = `${camera.brand} ${camera.model}`;
  $('#detailSerial').textContent = camera.serial;
  $('#detailColor').textContent = `${camera.color}, ${camera.shape}`;
  $('#detailInstalled').textContent = formatDate(camera.installed);
  $('#detailIp').textContent = camera.ip || 'Belum dikonfigurasi';
  $('#detailSince').textContent = camera.updated;
  const status = $('#detailStatus');
  status.className = `status-label ${camera.status}`;
  status.innerHTML = `<i></i>${statusText(camera.status)}`;
  $('#positionX').value = camera.x;
  $('#positionY').value = camera.y;
  setDirectionUI(camera.angle);
  updateEditingControls();
  if (shouldRender) renderCameras();
}

function closeDetail() {
  selectedId = null;
  $('#detailContent').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
  updateEditingControls();
  renderCameras();
}

function setDirectionUI(angle) {
  directionRange.value = angle;
  $('#directionValue').textContent = `${angle}°`;
  $('#detailDirection').textContent = directionText(angle);
  $('#compassNeedle').style.setProperty('--dir', `${angle}deg`);
}

function updateDirection(angle) {
  if (!editMode || !selectedId || !isAdmin()) return;
  const camera = cameras.find((item) => item.id === selectedId);
  camera.angle = Math.max(0, Math.min(359, Math.round(Number(angle))));
  camera.updated = 'Baru diperbarui';
  setDirectionUI(camera.angle);
  saveState();
  renderCameras();
}

function startDrag(event) {
  if (!editMode || !isAdmin()) return;
  event.preventDefault();
  const dragButton = event.currentTarget;
  const marker = dragButton.closest('.camera-marker');
  const id = marker.dataset.id;
  dragButton.setPointerCapture(event.pointerId);
  openDetail(id, false);
  document.querySelector('.camera-marker.selected')?.classList.remove('selected');
  marker.classList.add('selected');
  const startX = event.clientX;
  const startY = event.clientY;
  let moved = false;

  const move = (moveEvent) => {
    if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) return;
    moved = true;
    const bounds = mapArea.getBoundingClientRect();
    const camera = cameras.find((item) => item.id === id);
    camera.x = Number(Math.max(2, Math.min(98, ((moveEvent.clientX - bounds.left) / bounds.width) * 100)).toFixed(1));
    camera.y = Number(Math.max(2, Math.min(98, ((moveEvent.clientY - bounds.top) / bounds.height) * 100)).toFixed(1));
    marker.style.left = `${camera.x}%`;
    marker.style.top = `${camera.y}%`;
    $('#positionX').value = camera.x;
    $('#positionY').value = camera.y;
  };

  const end = () => {
    dragButton.removeEventListener('pointermove', move);
    dragButton.removeEventListener('pointerup', end);
    dragButton.removeEventListener('pointercancel', end);
    if (moved) {
      saveState();
      addHistory('Memindahkan titik', `${id} ke X ${$('#positionX').value}, Y ${$('#positionY').value}`);
      showToast(`Posisi ${id} disimpan`);
    }
  };
  dragButton.addEventListener('pointermove', move);
  dragButton.addEventListener('pointerup', end);
  dragButton.addEventListener('pointercancel', end);
}

function setEditMode(enabled) {
  editMode = Boolean(enabled && isAdmin());
  mapArea.classList.toggle('editing', editMode);
  $('#adminToggle').setAttribute('aria-pressed', String(editMode));
  $('#adminButtonText').textContent = editMode ? 'Selesai' : 'Edit peta';
  $('#editingHint').textContent = editMode ? 'Tarik titik atau ubah arah pada panel' : 'Pilih titik untuk melihat detail';
  updateEditingControls();
}

function updateEditingControls() {
  const enabled = editMode && Boolean(selectedId) && isAdmin();
  directionRange.disabled = !enabled;
  $$('.cardinal-buttons button').forEach((button) => { button.disabled = !enabled; });
  $('#positionEditor').classList.toggle('hidden', !enabled);
}

function updatePosition(axis, rawValue) {
  if (!editMode || !selectedId || !isAdmin()) return;
  const camera = cameras.find((item) => item.id === selectedId);
  camera[axis] = Number(Math.max(2, Math.min(98, Number(rawValue))).toFixed(1));
  saveState();
  addHistory('Memperbarui posisi', `${camera.id}: ${axis.toUpperCase()} ${camera[axis]}`);
  renderCameras();
}

function renderDeviceTable() {
  const query = $('#deviceSearch').value.trim().toLowerCase();
  const filter = $('#deviceStatusFilter').value;
  const filtered = cameras.filter((camera) => {
    const text = `${camera.id} ${camera.area} ${camera.location} ${camera.brand} ${camera.model} ${camera.ip}`.toLowerCase();
    return (!query || text.includes(query)) && (filter === 'all' || camera.status === filter);
  });

  $('#deviceTable').innerHTML = filtered.map((camera) => `
    <tr>
      <td class="mono">${escapeHtml(camera.id)}</td>
      <td>${escapeHtml(camera.area)}<small>${escapeHtml(camera.location)}</small></td>
      <td>${escapeHtml(camera.brand)} ${escapeHtml(camera.model)}<small>${escapeHtml(camera.serial)}</small></td>
      <td><span class="state-pill ${camera.status}">${escapeHtml(statusText(camera.status))}</span></td>
      <td class="mono">${escapeHtml(camera.ip || 'Belum diatur')}</td>
      <td><div class="table-actions"><button class="table-button" data-action="locate" data-id="${camera.id}">Peta</button><button class="table-button" data-action="live" data-id="${camera.id}">Tayangan</button>${isAdmin() ? `<button class="table-button" data-action="edit" data-id="${camera.id}">Ubah</button>` : ''}</div></td>
    </tr>`).join('');
  $('#deviceEmpty').classList.toggle('hidden', filtered.length > 0);
}

function renderReports() {
  const query = $('#reportSearch').value.trim().toLowerCase();
  const filter = $('#reportStatusFilter').value;
  const filtered = reports.filter((report) => {
    const text = `${report.id} ${report.cameraId} ${report.issue} ${report.note} ${report.reporter}`.toLowerCase();
    return (!query || text.includes(query)) && (filter === 'all' || report.status === filter);
  });

  $('#reportList').innerHTML = filtered.map((report) => {
    const nextAction = report.status === 'open' ? 'Mulai' : report.status === 'progress' ? 'Selesaikan' : '';
    return `<article class="report-item"><div><h3>${escapeHtml(report.id)}</h3><span class="state-pill ${report.status}">${escapeHtml(reportStatusText(report.status))}</span></div><div><p><strong>${escapeHtml(report.issue)}</strong> · ${escapeHtml(report.cameraId)}</p><small>${escapeHtml(report.note)}</small></div><div><span class="priority-pill ${report.priority}">${escapeHtml(priorityText(report.priority))}</span><small>${escapeHtml(report.reporter)} · ${escapeHtml(formatDate(report.createdAt, true))}</small></div><div class="report-actions"><button class="table-button" data-report-action="locate" data-id="${report.id}">Lihat CCTV</button>${isAdmin() && nextAction ? `<button class="table-button" data-report-action="advance" data-id="${report.id}">${nextAction}</button>` : ''}</div></article>`;
  }).join('');
  $('#reportEmpty').classList.toggle('hidden', filtered.length > 0);
  updateSummary();
}

function renderHistory() {
  const query = $('#historySearch').value.trim().toLowerCase();
  const filtered = historyItems.filter((item) => `${item.actor} ${item.action} ${item.detail}`.toLowerCase().includes(query));
  $('#historyList').innerHTML = filtered.map((item) => `<article class="timeline-item"><time>${escapeHtml(formatDate(item.createdAt, true))}</time><div><strong>${escapeHtml(item.action)}</strong><p>${escapeHtml(item.detail)} · ${escapeHtml(item.actor)}</p></div></article>`).join('');
  $('#historyEmpty').classList.toggle('hidden', filtered.length > 0);
}

function renderCameraSelects() {
  const options = cameras.map((camera) => `<option value="${camera.id}">${escapeHtml(camera.id)} · ${escapeHtml(camera.area)}</option>`).join('');
  const reportValue = $('#reportCamera').value;
  const networkValue = $('#networkCamera').value;
  $('#reportCamera').innerHTML = options;
  $('#networkCamera').innerHTML = options;
  if (cameras.some((camera) => camera.id === reportValue)) $('#reportCamera').value = reportValue;
  if (cameras.some((camera) => camera.id === networkValue)) $('#networkCamera').value = networkValue;
  fillStreamForm();
}

function renderProfile() {
  const { name, role, division } = settings.profile;
  $('#profileName').firstChild.textContent = name;
  $('#profileAvatar').textContent = name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  $('#roleName').textContent = `${role === 'admin' ? 'Administrator' : 'Pengguna'} · ${division}`;
  document.body.classList.toggle('user-role', role !== 'admin');
  $$('.admin-only').forEach((element) => element.classList.toggle('hidden', role !== 'admin'));
  if (role !== 'admin' && activeView === 'settings') showView('map');
  if (role !== 'admin') setEditMode(false);
}

function renderNetworkStatus() {
  const labels = { unknown: 'Belum diuji', connected: 'Terhubung', offline: 'Tidak terhubung' };
  const label = labels[settings.networkStatus] || labels.unknown;
  $('#connectionText').textContent = label;
  $('#networkState').textContent = label;
  $('#connectionDot').className = settings.networkStatus === 'connected' ? 'connected' : settings.networkStatus === 'offline' ? 'offline' : '';
  $('#networkState').className = `setting-state ${settings.networkStatus === 'unknown' ? '' : settings.networkStatus}`;
  $('#nvrAddress').value = settings.nvrAddress || '';
}

function renderAll() {
  renderDashboard();
  renderCameras();
  renderDeviceTable();
  renderReports();
  renderHistory();
  renderCameraSelects();
  renderProfile();
  renderNetworkStatus();
  saveState();
}

const pageMeta = {
  home: ['Terminal 1 / Lantai 2', 'Ringkasan'],
  map: ['Terminal 1 / Lantai 2', 'Peta CCTV'],
  devices: ['Inventaris', 'Perangkat CCTV'],
  reports: ['Operasional', 'Laporan gangguan'],
  history: ['Audit', 'Riwayat aktivitas'],
  settings: ['Administrator', 'Pengaturan sistem']
};

function setMobileMenu(open) {
  const sidebar = $('.sidebar');
  const toggle = $('#mobileMenuToggle');
  if (!sidebar || !toggle) return;
  sidebar.classList.toggle('menu-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.querySelector('span').textContent = open ? 'Tutup' : 'Menu';
}

function showView(view) {
  if (view === 'settings' && !isAdmin()) {
    showToast('Pengaturan hanya dapat dibuka oleh admin');
    return;
  }
  activeView = view;
  $$('.page-view').forEach((page) => page.classList.toggle('hidden', page.dataset.page !== view));
  $$('.nav-item').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    active ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current');
  });
  $('#pageContext').textContent = pageMeta[view][0];
  $('#pageTitle').textContent = pageMeta[view][1];
  $('#reportListButton').classList.toggle('hidden', view !== 'map');
  setMobileMenu(false);
  if (view === 'devices') renderDeviceTable();
  if (view === 'reports') renderReports();
  if (view === 'history') renderHistory();
  $('#mainContent').focus({ preventScroll: true });
}

function nextCameraId() {
  const max = cameras.reduce((result, camera) => Math.max(result, Number(camera.id.match(/(\d+)$/)?.[1] || 0)), 0);
  return `CCTV-T1-${String(max + 1).padStart(3, '0')}`;
}

function openDeviceDialog(id = null) {
  if (!isAdmin()) return showToast('Hanya admin yang dapat mengubah perangkat');
  const camera = id ? cameras.find((item) => item.id === id) : null;
  $('#deviceForm').reset();
  $('#deviceMode').value = camera ? 'edit' : 'add';
  $('#deviceDialogTitle').textContent = camera ? `Ubah ${camera.id}` : 'Tambah CCTV';
  $('#formId').readOnly = Boolean(camera);
  $('#formId').value = camera?.id || nextCameraId();
  $('#formStatus').value = camera?.status || 'normal';
  $('#formArea').value = camera?.area || '';
  $('#formLocation').value = camera?.location || '';
  $('#formBrand').value = camera?.brand || '';
  $('#formModel').value = camera?.model || '';
  $('#formSerial').value = camera?.serial || '';
  $('#formInstalled').value = camera?.installed || new Date().toISOString().slice(0, 10);
  $('#formColor').value = camera?.color || 'Putih';
  $('#formShape').value = camera?.shape || 'Dome';
  $('#formIp').value = camera?.ip || '';
  $('#formStream').value = camera?.streamUrl || '';
  $('#formAngle').value = camera?.angle ?? 0;
  $('#formX').value = camera?.x ?? 50;
  $('#formY').value = camera?.y ?? 50;
  $('#deviceDialog').showModal();
}

function openReportDialog(cameraId = '') {
  $('#reportForm').reset();
  renderCameraSelects();
  if (cameraId && cameras.some((camera) => camera.id === cameraId)) $('#reportCamera').value = cameraId;
  $('#reportTitle').textContent = cameraId ? `Laporkan ${cameraId}` : 'Buat laporan';
  $('#reportDialog').showModal();
}

function openConfirm(title, message, actionLabel, callback) {
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#confirmAction').textContent = actionLabel;
  pendingConfirm = callback;
  $('#confirmDialog').showModal();
}

function deleteSelectedDevice() {
  if (!selectedId || !isAdmin()) return;
  const camera = cameras.find((item) => item.id === selectedId);
  openConfirm('Hapus perangkat?', `${camera.id} dan titiknya akan dihapus dari peta. Riwayat laporan tetap tersimpan.`, 'Hapus', () => {
    cameras = cameras.filter((item) => item.id !== camera.id);
    addHistory('Menghapus perangkat', `${camera.id} · ${camera.location}`);
    closeDetail();
    renderAll();
    showToast(`${camera.id} dihapus`);
  });
}

function advanceReport(id) {
  if (!isAdmin()) return;
  const report = reports.find((item) => item.id === id);
  if (!report || report.status === 'resolved') return;
  report.status = report.status === 'open' ? 'progress' : 'resolved';
  if (report.status === 'resolved') {
    const stillActive = reports.some((item) => item.id !== id && item.cameraId === report.cameraId && item.status !== 'resolved');
    const camera = cameras.find((item) => item.id === report.cameraId);
    if (camera && !stillActive) {
      camera.status = 'normal';
      camera.updated = 'Baru diperbarui';
    }
  }
  addHistory(report.status === 'progress' ? 'Memulai perbaikan' : 'Menyelesaikan laporan', `${report.id} · ${report.cameraId}`);
  renderAll();
  showToast(`Status ${report.id}: ${reportStatusText(report.status)}`);
}

function fillStreamForm() {
  const camera = cameras.find((item) => item.id === $('#networkCamera').value) || cameras[0];
  if (!camera) return;
  $('#networkCamera').value = camera.id;
  $('#cameraIp').value = camera.ip || '';
  $('#cameraStream').value = camera.streamUrl || '';
}

function sanitizeSvg(source) {
  const documentSvg = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (documentSvg.querySelector('parsererror') || documentSvg.documentElement.tagName.toLowerCase() !== 'svg') throw new Error('File bukan SVG yang valid');
  documentSvg.querySelectorAll('script, foreignObject, iframe, object, embed').forEach((node) => node.remove());
  documentSvg.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'xlink:href') && /^(javascript:|https?:|data:text\/html)/.test(value)) || (name === 'style' && /(expression|url\s*\()/i.test(value))) node.removeAttribute(attribute.name);
    });
  });
  const svg = documentSvg.documentElement;
  if (!svg.getAttribute('viewBox')) {
    const width = parseFloat(svg.getAttribute('width')) || 1000;
    const height = parseFloat(svg.getAttribute('height')) || 660;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.classList.add('floor-plan');
  return svg.outerHTML;
}

function openLive(id) {
  const camera = cameras.find((item) => item.id === id);
  if (!camera) return;
  liveCameraId = id;
  $('#liveCameraTitle').textContent = camera.id;
  $('#liveLocation').textContent = `${camera.area} · ${camera.location}`;
  $('#liveIp').textContent = camera.ip || 'IP belum diatur';
  const status = $('#liveStatus');
  status.className = `status-label ${camera.status}`;
  status.innerHTML = `<i></i>${statusText(camera.status)}`;
  $('#liveDialog').showModal();
  loadLiveStream();
  clearInterval(liveClockTimer);
  const updateClock = () => { $('#liveClock').textContent = new Intl.DateTimeFormat('id-ID', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date()); };
  updateClock();
  liveClockTimer = setInterval(updateClock, 1000);
  addHistory('Membuka tayangan', camera.id);
}

function loadLiveStream() {
  const camera = cameras.find((item) => item.id === liveCameraId);
  if (!camera) return;
  const video = $('#liveVideo');
  const frame = $('#liveFrame');
  frame.classList.remove('has-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('#liveFallbackText').textContent = camera.streamUrl ? 'Menghubungkan ke tayangan lokal…' : 'Simulasi · URL tayangan belum diatur';
  if (!camera.streamUrl) return;
  video.src = camera.streamUrl;
  video.onloadeddata = () => {
    frame.classList.add('has-video');
    video.play().catch(() => {});
  };
  video.onerror = () => {
    frame.classList.remove('has-video');
    $('#liveFallbackText').textContent = 'Tayangan tidak dapat diputar. Periksa URL dan format video.';
  };
  video.load();
}

function closeLive() {
  clearInterval(liveClockTimer);
  const video = $('#liveVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('#liveFrame').classList.remove('has-video');
}

function exportHistoryCsv() {
  const rows = [['Waktu', 'Pengguna', 'Aktivitas', 'Detail'], ...historyItems.map((item) => [formatDate(item.createdAt, true), item.actor, item.action, item.detail])];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `riwayat-cctv-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast('Riwayat diekspor');
}

async function hashPassword(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function setAuthError(message = '') {
  const box = $('#authError');
  box.classList.toggle('hidden', !message);
  box.querySelector('span').textContent = message || '';
  if (message) box.focus();
}

function enterApp(account, recordLogin = false) {
  const overrides = settings.accountProfiles?.[account.email] || {};
  settings.profile = { name: account.name, email: account.email, role: account.role, division: account.division, ...overrides, role: account.role, email: account.email };
  sessionStorage.setItem(SESSION_KEY, account.email);
  $('#authScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  renderFloorPlan();
  renderAll();
  showView('home');
  if (recordLogin) addHistory('Masuk ke sistem', account.email, settings.profile.name);
}

function logout() {
  addHistory('Keluar dari sistem', settings.profile.email, settings.profile.name);
  sessionStorage.removeItem(SESSION_KEY);
  setEditMode(false);
  closeLive();
  $$('dialog[open]').forEach((dialog) => dialog.close());
  $('#appShell').classList.add('hidden');
  $('#authScreen').classList.remove('hidden');
  $('#loginForm').reset();
  $('#loginEmail').value = settings.profile.email || '';
  setAuthError();
  $('#loginEmail').focus();
}

function restoreSession() {
  const email = sessionStorage.getItem(SESSION_KEY);
  const account = ACCOUNTS.find((item) => item.email === email);
  if (account) enterApp(account, false);
  else {
    $('#authScreen').classList.remove('hidden');
    $('#appShell').classList.add('hidden');
    $('#loginEmail').focus();
  }
}

$('#mobileMenuToggle').addEventListener('click', () => setMobileMenu(!$('.sidebar').classList.contains('menu-open')));
$$('.nav-item').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('#reportListButton').addEventListener('click', () => showView('reports'));
$('#connectionButton').addEventListener('click', () => {
  setMobileMenu(false);
  isAdmin() ? showView('settings') : showToast(`Jaringan: ${$('#connectionText').textContent}`);
});
$('#adminToggle').addEventListener('click', () => { setEditMode(!editMode); showToast(editMode ? 'Mode edit aktif' : 'Perubahan peta disimpan'); });
$('#addCamera').addEventListener('click', () => openDeviceDialog());
$('#addDeviceList').addEventListener('click', () => openDeviceDialog());
$('#closeDetail').addEventListener('click', closeDetail);
$('#editDevice').addEventListener('click', () => openDeviceDialog(selectedId));
$('#deleteDevice').addEventListener('click', deleteSelectedDevice);
$('#reportButton').addEventListener('click', () => openReportDialog(selectedId));
$('#newReportButton').addEventListener('click', () => openReportDialog());
$('#liveView').addEventListener('click', () => openLive(selectedId));
$('#viewAllIssues').addEventListener('click', () => { $('#mapStatusFilter').value = 'all'; showView('map'); renderCameras(); });
$('#viewAllReports').addEventListener('click', () => showView('reports'));
$('#dashboardMapButton').addEventListener('click', () => showView('map'));
$('#dashboardReportButton').addEventListener('click', () => openReportDialog());
$('#dashboardAlerts').addEventListener('click', (event) => {
  const button = event.target.closest('[data-dashboard-camera]');
  if (!button) return;
  $('#search').value = '';
  $('#mapStatusFilter').value = 'all';
  showView('map');
  openDetail(button.dataset.dashboardCamera);
});
$('#dashboardReports').addEventListener('click', (event) => {
  if (!event.target.closest('[data-dashboard-report]')) return;
  showView('reports');
});

$('#search').addEventListener('input', renderCameras);
$('#mapStatusFilter').addEventListener('change', renderCameras);
$('#deviceSearch').addEventListener('input', renderDeviceTable);
$('#deviceStatusFilter').addEventListener('change', renderDeviceTable);
$('#reportSearch').addEventListener('input', renderReports);
$('#reportStatusFilter').addEventListener('change', renderReports);
$('#historySearch').addEventListener('input', renderHistory);
$('#exportHistory').addEventListener('click', exportHistoryCsv);

directionRange.addEventListener('input', (event) => updateDirection(event.target.value));
directionRange.addEventListener('change', () => {
  const camera = cameras.find((item) => item.id === selectedId);
  if (camera) addHistory('Memperbarui arah', `${camera.id} menjadi ${camera.angle}°`);
  showToast('Arah kamera disimpan');
});
$$('.cardinal-buttons button').forEach((button) => button.addEventListener('click', () => {
  updateDirection(button.dataset.angle);
  const camera = cameras.find((item) => item.id === selectedId);
  if (camera) addHistory('Memperbarui arah', `${camera.id} menjadi ${camera.angle}°`);
  showToast(`Arah diubah ke ${directionText(Number(button.dataset.angle)).split(' · ')[0]}`);
}));
$('#positionX').addEventListener('change', (event) => updatePosition('x', event.target.value));
$('#positionY').addEventListener('change', (event) => updatePosition('y', event.target.value));

$('#deviceTable').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'locate') {
    $('#search').value = '';
    $('#mapStatusFilter').value = 'all';
    showView('map');
    openDetail(button.dataset.id);
  }
  if (button.dataset.action === 'live') openLive(button.dataset.id);
  if (button.dataset.action === 'edit') openDeviceDialog(button.dataset.id);
});

$('#reportList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-report-action]');
  if (!button) return;
  const report = reports.find((item) => item.id === button.dataset.id);
  if (button.dataset.reportAction === 'locate' && report) {
    if (cameras.some((camera) => camera.id === report.cameraId)) {
      showView('map');
      openDetail(report.cameraId);
    } else {
      showToast('Perangkat pada laporan ini sudah dihapus');
    }
  }
  if (button.dataset.reportAction === 'advance') advanceReport(button.dataset.id);
});

$('#deviceForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!isAdmin()) return;
  const id = $('#formId').value.trim().toUpperCase();
  const mode = $('#deviceMode').value;
  if (mode === 'add' && cameras.some((camera) => camera.id === id)) return showToast('ID CCTV sudah digunakan');
  const data = {
    id,
    status: $('#formStatus').value,
    area: $('#formArea').value.trim(),
    location: $('#formLocation').value.trim(),
    brand: $('#formBrand').value.trim(),
    model: $('#formModel').value.trim(),
    serial: $('#formSerial').value.trim(),
    installed: $('#formInstalled').value,
    color: $('#formColor').value.trim() || 'Belum diisi',
    shape: $('#formShape').value,
    ip: $('#formIp').value.trim(),
    streamUrl: $('#formStream').value.trim(),
    angle: Number($('#formAngle').value),
    x: Number($('#formX').value),
    y: Number($('#formY').value),
    updated: 'Baru diperbarui'
  };
  if (mode === 'add') cameras.push(data);
  else cameras[cameras.findIndex((camera) => camera.id === id)] = data;
  selectedId = id;
  saveState();
  addHistory(mode === 'add' ? 'Menambah perangkat' : 'Memperbarui perangkat', `${id} · ${data.location}`);
  $('#deviceDialog').close();
  renderAll();
  if (activeView === 'map') openDetail(id);
  showToast(`${id} disimpan`);
});

$('#reportForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const cameraId = $('#reportCamera').value;
  const year = new Date().getFullYear();
  const sequence = reports.reduce((max, report) => Math.max(max, Number(report.id.match(/(\d+)$/)?.[1] || 0)), 0) + 1;
  const report = { id: `RPT-${year}-${String(sequence).padStart(3, '0')}`, cameraId, issue: $('#reportIssue').value, priority: $('#reportPriority').value, note: $('#reportNote').value.trim(), status: 'open', reporter: `${settings.profile.name} / ${settings.profile.division}`, createdAt: new Date().toISOString() };
  reports.unshift(report);
  const camera = cameras.find((item) => item.id === cameraId);
  if (camera) {
    camera.status = report.issue === 'Perangkat offline' ? 'offline' : 'warning';
    camera.updated = 'Laporan baru';
  }
  addHistory('Membuat laporan', `${report.id} · ${cameraId}`);
  $('#reportDialog').close();
  renderAll();
  showToast(`${report.id} berhasil dibuat`);
});

$('#confirmForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const callback = pendingConfirm;
  pendingConfirm = null;
  $('#confirmDialog').close();
  if (callback) callback();
});

$('#profileButton').addEventListener('click', () => {
  setMobileMenu(false);
  $('#accountName').value = settings.profile.name;
  $('#accountEmail').value = settings.profile.email;
  $('#accountRole').value = settings.profile.role === 'admin' ? 'Administrator' : 'Pengguna';
  $('#accountDivision').value = settings.profile.division;
  $('#profileDialog').showModal();
});

$('#profileForm').addEventListener('submit', (event) => {
  event.preventDefault();
  settings.profile = { ...settings.profile, name: $('#accountName').value.trim(), division: $('#accountDivision').value };
  settings.accountProfiles = settings.accountProfiles || {};
  settings.accountProfiles[settings.profile.email] = { name: settings.profile.name, division: settings.profile.division };
  saveState();
  addHistory('Memperbarui profil', `${settings.profile.role} · ${settings.profile.division}`);
  $('#profileDialog').close();
  renderAll();
  showToast('Profil diperbarui');
});

$('#logoutButton').addEventListener('click', logout);

$('#networkForm').addEventListener('submit', (event) => {
  event.preventDefault();
  settings.nvrAddress = $('#nvrAddress').value.trim();
  settings.networkStatus = 'unknown';
  saveState();
  addHistory('Menyimpan alamat NVR', settings.nvrAddress);
  renderNetworkStatus();
  showToast('Alamat NVR disimpan');
});

$('#testNetwork').addEventListener('click', async () => {
  const address = $('#nvrAddress').value.trim();
  if (!address) return showToast('Masukkan alamat NVR');
  const button = $('#testNetwork');
  button.disabled = true;
  button.textContent = 'Menguji…';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    await fetch(address, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    settings.networkStatus = 'connected';
    showToast('NVR dapat dijangkau');
  } catch (error) {
    settings.networkStatus = 'offline';
    showToast('NVR tidak dapat dijangkau');
  } finally {
    clearTimeout(timeout);
    settings.nvrAddress = address;
    settings.networkCheckedAt = new Date().toISOString();
    saveState();
    renderNetworkStatus();
    button.disabled = false;
    button.textContent = 'Uji koneksi';
    addHistory('Menguji koneksi NVR', `${address} · ${settings.networkStatus}`);
  }
});

$('#networkCamera').addEventListener('change', fillStreamForm);
$('#streamForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const camera = cameras.find((item) => item.id === $('#networkCamera').value);
  if (!camera) return;
  camera.ip = $('#cameraIp').value.trim();
  camera.streamUrl = $('#cameraStream').value.trim();
  camera.updated = 'Konfigurasi jaringan diperbarui';
  saveState();
  addHistory('Memperbarui tayangan', `${camera.id} · ${camera.ip || 'tanpa IP'}`);
  renderAll();
  showToast(`Konfigurasi ${camera.id} disimpan`);
});

$('#mapFile').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.svg')) {
    event.target.value = '';
    return showToast('Pilih file SVG');
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      settings.customMap = sanitizeSvg(String(reader.result));
      saveState();
      renderFloorPlan();
      addHistory('Mengimpor denah SVG', file.name);
      showView('map');
      showToast('Denah SVG berhasil dipasang');
    } catch (error) {
      showToast(error.message);
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file);
});

$('#resetMap').addEventListener('click', () => openConfirm('Gunakan denah bawaan?', 'SVG impor akan dilepas. Data dan posisi CCTV tidak ikut dihapus.', 'Gunakan bawaan', () => {
  settings.customMap = '';
  saveState();
  renderFloorPlan();
  addHistory('Mengganti denah', 'Kembali ke denah bawaan');
  showToast('Denah bawaan digunakan');
}));

$('#refreshLive').addEventListener('click', loadLiveStream);
$('#fullscreenLive').addEventListener('click', () => $('#liveFrame').requestFullscreen?.());
$('#liveDialog').addEventListener('close', closeLive);

$('#togglePassword').addEventListener('click', () => {
  const input = $('#loginPassword');
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  $('#togglePassword').textContent = reveal ? 'Sembunyi' : 'Lihat';
  $('#togglePassword').setAttribute('aria-label', reveal ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
});

$$('[data-demo-account]').forEach((button) => button.addEventListener('click', () => {
  const admin = button.dataset.demoAccount === 'admin';
  $('#loginEmail').value = admin ? 'admin@airport.local' : 'user@airport.local';
  $('#loginPassword').value = admin ? 'Admin123!' : 'User123!';
  $('#emailError').textContent = '';
  $('#passwordError').textContent = '';
  setAuthError();
  $('#loginButton').focus();
}));

$('#loginEmail').addEventListener('input', () => {
  $('#loginEmail').removeAttribute('aria-invalid');
  $('#emailError').textContent = '';
  setAuthError();
});

$('#loginPassword').addEventListener('input', () => {
  $('#loginPassword').removeAttribute('aria-invalid');
  $('#passwordError').textContent = '';
  setAuthError();
});

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const emailInput = $('#loginEmail');
  const passwordInput = $('#loginPassword');
  const email = emailInput.value.trim().toLowerCase();
  let valid = true;
  $('#emailError').textContent = '';
  $('#passwordError').textContent = '';
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
  if (!valid) {
    (emailInput.getAttribute('aria-invalid') ? emailInput : passwordInput).focus();
    return;
  }

  const button = $('#loginButton');
  button.disabled = true;
  button.textContent = 'Memeriksa…';
  try {
    const passwordHash = await hashPassword(passwordInput.value);
    const account = ACCOUNTS.find((item) => item.email === email && item.passwordHash === passwordHash);
    if (!account) {
      passwordInput.setAttribute('aria-invalid', 'true');
      setAuthError('Periksa kembali email dan kata sandi, lalu coba lagi.');
      return;
    }
    enterApp(account, true);
    $('#loginForm').reset();
    $('#loginPassword').type = 'password';
    $('#togglePassword').textContent = 'Lihat';
  } catch (error) {
    setAuthError('Autentikasi tidak dapat dijalankan di browser ini.');
  } finally {
    button.disabled = false;
    button.textContent = 'Masuk';
  }
});

$$('[data-close]').forEach((button) => button.addEventListener('click', () => {
  const dialog = document.getElementById(button.dataset.close);
  if (dialog.id === 'liveDialog') closeLive();
  dialog.close();
}));

restoreSession();
