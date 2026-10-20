# Audit Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menutup celah keamanan, mencegah server crash, dan memastikan semua data (laporan, riwayat, pengaturan, RTSP) benar-benar tersimpan di PostgreSQL dan dibagikan ke semua pengguna LAN.

**Architecture:** Tetap sama: Node.js (`server.js`) satu-satunya komponen yang terbuka ke LAN; PostgreSQL hanya localhost. Browser hanya memegang cookie sesi HttpOnly dan state tampilan sementara. RTSP hanya didekripsi di server dan tidak pernah dikirim ke browser.

**Tech Stack:** Node.js 22+ (saat ini v24), PostgreSQL 17, `pg`, `node:crypto`, `node:test`, Playwright/Edge.

**Sumber:** Audit kode 2026-10-19 (lihat bagian "Temuan" di bawah).

## Kondisi awal (wajib dibaca)

- Ada 11 file belum di-commit (`app.js`, `server.js`, `index.html`, `styles.css`, `db/bootstrap.js`, `package.json`, `tests/api-cameras.test.js`, `tests/server.test.js`, docs). **Commit dulu** perubahan itu sebagai baseline sebelum mulai Task 1, atau tanyakan pemilik repo.
- `npm test` saat ini lulus 15/15, tetapi hanya menjalankan 3 dari 16 file test.
- Setiap task harus diakhiri dengan `npm test` hijau dan satu commit.

## Global Constraints

- Jangan mengubah skema secara destruktif; hanya `CREATE ... IF NOT EXISTS` / `ALTER ... ADD COLUMN IF NOT EXISTS` di `db/schema.sql`.
- Tidak menambah dependency npm kecuali benar-benar perlu (rate limit, header, dll. cukup ditulis manual).
- Pesan error ke pengguna tetap Bahasa Indonesia, format `{ error: 'snake_case', message: '...' }` seperti yang sudah ada.
- URL RTSP tidak boleh muncul di response API, log, atau browser.
- Semua endpoint `/api/*` selain `/api/auth/login` dan `/api/auth/session` wajib sesi valid.

---

## Temuan

| # | Prioritas | Lokasi | Masalah |
|---|-----------|--------|---------|
| 1 | Kritis | `server.js:395`, `server.js:425`, `server.js:458` | `/api/ping` & `/api/streams` tanpa autentikasi; ping menerima IP publik; jumlah proses FFmpeg tidak dibatasi (DoS). |
| 2 | Kritis | `server.js:241`, `:249`, `:304` | `getSessionUser`/query logout di luar try/catch → unhandled rejection → proses Node mati saat DB bermasalah. |
| 3 | Kritis | `server.js:188` | Login tanpa rate limit (brute force). |
| 4 | Tinggi | `app.js:889-900` | Browser mengirim URL RTSP (berisi kredensial kamera) dalam plaintext ke `/api/streams`. |
| 5 | Tinggi | `server.js:514` | Tidak ada CSP / X-Frame-Options / Referrer-Policy di aset HTML. |
| 6 | Tinggi | `app.js:128` | `saveState()` kosong → laporan, riwayat, pengaturan NVR, hasil ping hilang saat refresh & tidak terbagi antar-user. Tabel `reports`, `activity_history`, `settings` belum punya API. |
| 7 | Tinggi | `server.js:164`, `lib/rtsp-secrets.js` | RTSP terenkripsi tidak pernah dipakai lagi (`decryptRtsp` tidak dipanggil) → live view mati setelah refresh. |
| 8 | Sedang | `app.js:1249` | Form "Simpan konfigurasi jaringan" tidak memanggil API. |
| 9 | Sedang | `server.js:474` | Tiap GET stream mematikan FFmpeg sebelumnya → penonton kedua memutus yang pertama. |
| 10 | Sedang | `server.js:282` | POST kamera: `x`/`y` tidak di-clamp, `0` jadi `50`; field `details` tidak divalidasi tipe; `status` bebas. |
| 11 | Rendah | `server.js:313` | DELETE kamera + insert riwayat tidak dalam satu transaksi. |
| 12 | Rendah | `lib/sessions.js:22` | `DELETE` sesi kedaluwarsa dijalankan di setiap request. |
| 13 | Rendah | `config.js`, `index.html:266`, `app.js:1322` | `SESSION_SECRET` tidak dipakai; `sha256.js` dimuat tanpa guna; handler akun demo + password hardcoded (`Admin123!`) masih ada. |
| 14 | Rendah | `package.json` | `npm test` melewatkan 13 file test. |
| 15 | Rendah | `server.js:67` | Ping hanya jalan di Windows (`ping.exe`). |

---

### Task 1: Stabilitas server (temuan #2)

**Files:**
- Modify: `server.js`
- Modify: `tests/api-auth.test.js`, `tests/api-cameras.test.js`

- [ ] **Step 1: Tulis test gagal** — buat `pool` palsu yang `query()`-nya `reject(new Error('db down'))`; panggil `GET /api/cameras`, `PATCH /api/cameras/X`, `POST /api/auth/logout`. Harapan: status `503`/`500` JSON, proses tidak crash.
- [ ] **Step 2: Bungkus handler utama** — pindahkan isi callback `http.createServer` ke fungsi `async handle(request, response)` lalu:
  ```js
  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      logError('Permintaan gagal:', error.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error', message: 'Server mengalami gangguan.' });
      else response.destroy();
    });
  });
  ```
- [ ] **Step 3: Tambah di blok `require.main`:** `process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.message))`.
- [ ] **Step 4:** `npm test` hijau → commit `fix: keep server alive when database calls fail`.

**Selesai bila:** mematikan service PostgreSQL saat server jalan tidak membuat proses Node berhenti.

---

### Task 2: Autentikasi & pembatasan ping/stream (temuan #1)

**Files:**
- Modify: `server.js`
- Modify: `tests/server.test.js`, `tests/camera_network.spec.js`

- [ ] **Step 1: Helper auth** — buat `async function requireUser(request, response)` yang mengembalikan user atau mengirim `401` dan `null`. Pakai di `/api/cameras`, `/api/cameras/:code`, `/api/ping`, `/api/streams`, `/api/streams/:token`.
- [ ] **Step 2: Ping hanya IP privat** — di `/api/ping` ganti `isValidIpv4` dengan `isPrivateIpv4`; error `invalid_ip` dengan pesan "Hanya alamat IPv4 jaringan lokal yang dapat di-ping."
- [ ] **Step 3: Batasi ping bersamaan** — counter `activePings`; jika `>= 8` balas `429 { error: 'too_many_pings' }`.
- [ ] **Step 4: Sesi stream terikat user** — simpan `userId` di `streamSessions`; `GET`/`DELETE /api/streams/:token` hanya untuk user yang sama (lainnya `404`).
- [ ] **Step 5: Batas sesi** — maks 4 sesi per user, maks `MAX_STREAMS` (env, default 8) total; lebih → `429 { error: 'stream_limit' }`.
- [ ] **Step 6: Test** — request tanpa cookie → 401; IP `8.8.8.8` → 400; sesi ke-5 → 429; token user lain → 404.
- [ ] **Step 7:** commit `fix: require login and limits for ping and stream endpoints`.

---

### Task 3: Rate limit login (temuan #3)

**Files:**
- Create: `lib/rate-limit.js`
- Create: `tests/rate-limit.test.js`
- Modify: `server.js`

- [ ] **Step 1:** `createRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 })` berbasis `Map` dengan kunci `ip + '|' + email`; method `hit(key)` → `{ allowed, retryAfterSec }`, `reset(key)`. Bersihkan entri lama dengan `setInterval(...).unref()`.
- [ ] **Step 2:** Di `/api/auth/login`, sebelum `verifyPassword`: jika tidak `allowed` → `429` + header `Retry-After`, pesan "Terlalu banyak percobaan. Coba lagi dalam N menit." Panggil `reset` saat login sukses.
- [ ] **Step 3:** IP diambil dari `request.socket.remoteAddress` (jangan percaya `X-Forwarded-For`).
- [ ] **Step 4:** Unit test limiter + test API (percobaan ke-6 → 429). Commit `feat: rate-limit login attempts`.

---

### Task 4: Security headers (temuan #5)

**Files:**
- Modify: `server.js`
- Modify: `tests/server.test.js`

- [ ] **Step 1:** Konstanta `SECURITY_HEADERS` dipasang di respons aset dan `sendJson`:
  ```
  Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  ```
- [ ] **Step 2:** Buka aplikasi di browser, pastikan tidak ada pelanggaran CSP di console (cek terutama inline style SVG denah dan `<video>`). Sesuaikan direktif bila perlu, **jangan** tambah `'unsafe-eval'`.
- [ ] **Step 3:** Test: `GET /` memuat header di atas. Commit `feat: add security headers`.

---

### Task 5: Stream dari RTSP tersimpan di server (temuan #4, #7, #9)

**Files:**
- Modify: `server.js`
- Modify: `app.js` (`openLive` sekitar baris 870–910, form kamera `#formStream`, form jaringan `#cameraStream`)
- Modify: `tests/server.test.js`, `tests/rtsp_ui.spec.js`, `docs/api.md`

- [ ] **Step 1: Kontrak API baru** — `POST /api/streams` menerima `{ cameraCode }` (bukan `url`). Server:
  ```sql
  SELECT s.encrypted_rtsp FROM camera_streams s JOIN cameras c ON c.id = s.camera_id WHERE c.camera_code = $1
  ```
  lalu `decryptRtsp(..., rtspEncryptionKey)` dan `parseRtspUrl` ulang. Tidak ada baris → `404 { error: 'stream_not_configured' }`. Hapus dukungan `{ url }`.
- [ ] **Step 2: Penanda di daftar kamera** — `GET /api/cameras` tambahkan `LEFT JOIN camera_streams` dan kembalikan `hasStream: boolean` (bukan URL).
- [ ] **Step 3: Satu FFmpeg untuk banyak penonton** — kunci proses per `cameraCode`: `Map<cameraCode, { child, viewers: Set<response>, initSegment: Buffer }>`. Simpan chunk pertama sampai `moov` selesai sebagai `initSegment`, kirim ke penonton baru lalu teruskan data berikutnya. Matikan `child` saat `viewers` kosong (tunda 5 detik). Jika fragmentasi MP4 terlalu rumit, alternatif yang diterima: biarkan satu proses per penonton tapi **jangan** membunuh proses milik sesi lain.
- [ ] **Step 4: Frontend** — `openLive` memakai `camera.hasStream` dan mengirim `{ cameraCode: camera.id }`. Field input RTSP di form tetap ada tapi kosong saat edit (placeholder "Tersimpan — isi untuk mengganti"); jangan pernah mengisi dari data server.
- [ ] **Step 5: Hapus RTSP** — `PATCH` dengan `streamUrl: ''` eksplisit + flag `clearStream: true` menghapus baris `camera_streams`.
- [ ] **Step 6: Test** — refresh halaman lalu buka live → stream jalan; dua tab menonton kamera sama → keduanya tetap jalan; response `/api/cameras` tidak memuat string `rtsp://`.
- [ ] **Step 7:** Update `docs/api.md`. Commit `feat: serve live view from server-side encrypted RTSP`.

---

### Task 6: API laporan, riwayat, pengaturan (temuan #6, #8, #11)

**Files:**
- Modify: `db/schema.sql`
- Modify: `server.js` (pertimbangkan memecah route ke `routes/*.js` bila `server.js` > 800 baris)
- Modify: `app.js` (`reports`, `addHistory`, `settings`, `saveState`, form `#streamForm`, `#testNetwork`, `#pingCamera`)
- Create: `tests/api-reports.test.js`, `tests/api-history.test.js`, `tests/api-settings.test.js`
- Modify: `docs/api.md`, `docs/database.md`

- [ ] **Step 1: Skema** — tabel `reports` perlu kolom yang dipakai UI: `ALTER TABLE reports ADD COLUMN IF NOT EXISTS report_code TEXT UNIQUE, ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'`. Perluas CHECK status sesuai alur UI (`open` → `in_progress` → `resolved`; cek `reportStatusText` di `app.js`). Tambah kolom `last_ping JSONB` di `cameras` atau simpan di `details.lastPing`.
- [ ] **Step 2: Endpoint**

  | Method | Path | Akses | Isi |
  |---|---|---|---|
  | GET | `/api/reports` | user | daftar, terbaru dulu, limit 200 |
  | POST | `/api/reports` | user | `{ cameraCode, issue, note, priority }` |
  | PATCH | `/api/reports/:code` | admin | `{ status }` maju satu tahap |
  | GET | `/api/history?limit=100` | user | join `users.email` sebagai actor |
  | GET | `/api/settings` | user | semua key |
  | PUT | `/api/settings/:key` | admin | whitelist key: `nvrAddress`, `networkStatus`, `networkCheckedAt` |
  | POST | `/api/cameras/:code/ping` | user | ping IP kamera dari DB, simpan `lastPing`, catat riwayat |

  Semua mutasi menulis `activity_history` dalam **transaksi yang sama**. Perbaiki juga DELETE kamera (`server.js:313`) agar memakai transaksi.
- [ ] **Step 3: Frontend** — hapus `saveState()`; `addHistory` tidak lagi menulis lokal (riwayat dibuat server), cukup `loadHistory()` ulang. `#streamForm` memanggil `PATCH /api/cameras/:code` dengan `{ ip, streamUrl }`. `#pingCamera` memakai endpoint ping per kamera.
- [ ] **Step 4: Verifikasi multi-user** — dua browser (admin & operator): laporan dari operator terlihat di admin setelah reload; refresh tidak menghilangkan data.
- [ ] **Step 5:** Commit `feat: persist reports, history and settings in PostgreSQL`.

---

### Task 7: Validasi input kamera (temuan #10)

**Files:**
- Modify: `server.js`
- Modify: `tests/api-cameras.test.js`

- [ ] **Step 1:** Ekstrak `function normalizeCameraInput(data, current = {})` dipakai POST & PATCH:
  - `x`, `y`: clamp 0–100, default 50 hanya jika bukan angka (jangan `|| 50`).
  - `status` ∈ `normal|warning|offline`; `floor` ∈ `gf|ff`; `angle` 0–359.
  - String (`location`, `brand`, `model`, `serial`, `color`, `shape`): tipe string, maks 120 karakter; `installed` format `YYYY-MM-DD` atau kosong.
  - `id`: regex `^[A-Z0-9-]{3,32}$`.
- [ ] **Step 2:** Test kasus `x: 0` tersimpan 0, `status: 'hack'` → 400, `brand: {}` → 400. Commit `fix: validate camera fields`.

---

### Task 8: Efisiensi sesi (temuan #12)

**Files:** `lib/sessions.js`, `server.js`, `tests/sessions.test.js`

- [ ] Hapus `DELETE` dari `getSessionUser`; tambahkan `pruneExpiredSessions(pool)` dan jalankan via `setInterval(..., 15 * 60 * 1000).unref()` di blok `require.main`. Test tetap memastikan sesi kedaluwarsa tidak lolos (filter `expires_at > now()` sudah ada). Commit `perf: prune sessions on a timer`.

---

### Task 9: Bersih-bersih & test runner (temuan #13, #14, #15)

**Files:** `config.js`, `.env.example`, `index.html`, `app.js`, `server.js`, `sha256.js`, `tests/sha256.test.js`, `package.json`, `docs/*`

- [ ] **Step 1:** Hapus handler `[data-demo-account]` (`app.js:1322-1330`) beserta password hardcoded.
- [ ] **Step 2:** Cek apakah `sha256.js` dipakai `app.js` (`grep -n sha256 app.js`). Jika tidak: hapus `<script src="sha256.js">`, entri di `ASSETS`, file, dan test-nya.
- [ ] **Step 3:** `SESSION_SECRET`: hapus dari `requireValue` & `.env.example` (sesi sudah memakai token acak + hash), atau gunakan untuk HMAC `tokenDigest`. Pilih salah satu dan dokumentasikan di `docs/security.md`.
- [ ] **Step 4:** Ping lintas OS — `process.platform === 'win32'` ? `['-n','1','-w','1500']` : `['-c','1','-W','2']`, executable `ping`.
- [ ] **Step 5:** `package.json`:
  ```json
  "test": "node --test tests/*.test.js",
  "test:e2e": "node --test tests/*.spec.js"
  ```
  Perbaiki test yang gagal setelah perubahan ini.
- [ ] **Step 6:** Hapus `server-error.log`/`server-output.log` dari working tree (sudah di `.gitignore`). Commit `chore: remove dead code and run full test suite`.

---

## Checklist akhir

- [ ] `npm test` menjalankan semua `*.test.js` dan hijau.
- [ ] Tanpa login: `POST /api/ping`, `POST /api/streams`, `GET /api/reports` → 401.
- [ ] DB dimatikan saat server jalan → server tetap hidup, API mengembalikan 5xx JSON.
- [ ] Refresh browser: laporan, riwayat, pengaturan NVR, live view tetap ada.
- [ ] `grep -rn "rtsp://" ` pada response API dan log server: kosong.
- [ ] `docs/api.md`, `docs/security.md`, `docs/database.md` diperbarui.
