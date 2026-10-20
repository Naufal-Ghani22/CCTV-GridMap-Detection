# Referensi API

Semua endpoint `/api/*` memakai JSON dan cookie sesi `cctv_session` (HttpOnly). Kecuali login dan logout, setiap endpoint wajib sesi valid. Respons tidak pernah memuat kata sandi, `DATABASE_URL`, maupun URL RTSP.

Format galat: `{ "error": "snake_case", "message": "Pesan Bahasa Indonesia" }`.

| Metode | Endpoint | Akses | Fungsi |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | publik | Login `{ email, password }`; dibatasi 5 percobaan / 15 menit per IP+email |
| `GET` | `/api/auth/session` | publik | `{ user }` atau `{ user: null }` |
| `POST` | `/api/auth/logout` | publik | Mengakhiri sesi |
| `PATCH` | `/api/me` | user | Ubah `name`, `division`, atau kata sandi (`currentPassword`, `newPassword`) |
| `GET` / `POST` | `/api/users` | admin | Daftar / tambah akun `{ email, name, division, role, password }` |
| `PATCH` / `DELETE` | `/api/users/:id` | admin | Ubah peran, nonaktifkan (`isActive`), reset `password`, hapus |
| `GET` | `/api/cameras` | user | Daftar CCTV beserta `status`, `lastPing`, `hasStream` |
| `POST` | `/api/cameras` | admin | Tambah CCTV |
| `PATCH` | `/api/cameras/:kode` | admin | Ubah sebagian kolom; `streamUrl` mengganti RTSP, `clearStream: true` menghapusnya |
| `DELETE` | `/api/cameras/:kode` | admin | Hapus CCTV |
| `POST` | `/api/cameras/:kode/ping` | user | Ping IP CCTV sekarang dan simpan hasilnya |
| `GET` / `POST` | `/api/reports` | user | Daftar / buat laporan `{ cameraCode, issue, priority, note }` |
| `PATCH` | `/api/reports/:kode` | admin | Status `open` → `progress` → `resolved` |
| `GET` | `/api/history?limit=300` | user | Riwayat audit (maks. 2000) |
| `GET` | `/api/settings` | user | NVR, area, interval monitor, status denah |
| `PUT` | `/api/settings/nvrs` \| `areas` \| `monitor` | admin | Simpan daftar NVR, area, atau `{ intervalSec }` |
| `GET` / `PUT` / `DELETE` | `/api/maps/gf` \| `ff` | user / admin | Denah SVG; `PUT` dengan `Content-Type: image/svg+xml` (maks. 6 MB) |
| `GET` | `/api/monitor` | user | Status monitor ping dan hasil ping NVR |
| `POST` | `/api/monitor/run` | admin | Jalankan pemeriksaan jaringan sekarang |
| `GET` | `/api/events` | user | Server-Sent Events: `cameras`, `reports`, `history`, `settings`, `users`, `monitor` |
| `POST` | `/api/ping` | user | Ping satu IPv4 privat `{ ip }` (maks. 8 bersamaan) |
| `GET` | `/api/streams` | user | Batas tayangan `{ maxTotal, maxPerUser, active, mine, available }` (`available` = FFmpeg ada) |
| `POST` | `/api/streams` | user | Sesi tayangan `{ cameraCode }` → `{ playbackUrl }` |
| `GET` / `DELETE` | `/api/streams/:token` | pemilik sesi | Putar MP4 / tutup tayangan |
| `GET` (WebSocket) | `/api/streams/:token/ws` | pemilik sesi | MP4 terfragmentasi sebagai frame biner untuk grid View; `Origin` harus sama dengan host |

Token tayangan yang tidak sedang ditonton kedaluwarsa setelah 10 menit; selama ditonton, tayangan tetap terbuka.

## Objek CCTV

```json
{
  "id": "CCTV-T1-021", "area": "Boarding", "location": "Dekat Gate B3", "floor": "gf",
  "x": 51.2, "y": 37.4, "angle": 315, "fov": 90, "range": 1.5,
  "brand": "Hikvision", "model": "DS-2CD2143G2-I", "serial": "HKV-T1-0021", "shape": "Dome", "color": "Putih",
  "ip": "192.168.1.64", "nvr": "nvr-1", "installed": "2024-03-12", "notes": "",
  "status": "offline", "manualStatus": "normal", "statusSource": "ping",
  "lastPing": { "status": "offline", "latencyMs": null, "checkedAt": "…", "failures": 2, "ip": "192.168.1.64" },
  "hasStream": true, "updatedAt": "…"
}
```

- `x`, `y`: persen 0–100 dari lebar/tinggi denah.
- `angle`: 0–359°, 0° = atas denah (utara), searah jarum jam.
- `fov`: sudut pandang 10–360° (360 = fisheye). `range`: jari-jari kerucut, persen dari lebar denah (0,2–12).
- `status` adalah status efektif: `offline` bila ping gagal ≥ 2 kali berturut-turut, selain itu `manualStatus` (diatur admin atau laporan).

Status HTTP umum: `200`, `201`, `204`, `400` input invalid, `401` belum login, `403` bukan admin, `404` tidak ditemukan, `409` duplikat/konflik, `413` terlalu besar, `429` dibatasi, `503` database/FFmpeg tidak tersedia.
