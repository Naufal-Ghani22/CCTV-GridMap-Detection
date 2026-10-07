# Arsitektur Sistem

```text
Browser petugas ── HTTP LAN :8080 ──> Node.js / CCTV Grid Map
                                            │
                                            ├── PostgreSQL :5432 (localhost saja)
                                            ├── FFmpeg ── RTSP ──> Kamera/NVR LAN
                                            └── File denah dan antarmuka web

pgAdmin (administrator lokal) ──> PostgreSQL :5432
```

| Komponen | Fungsi | Akses |
| --- | --- | --- |
| Browser | Peta, inventaris, ping, dan live view | Petugas LAN |
| Node.js | Web, autentikasi, API, ping, jembatan video | Port 8080 LAN |
| PostgreSQL | Pengguna, kamera, stream terenkripsi, laporan, riwayat, sesi | Hanya localhost |
| pgAdmin | Administrasi database | Administrator server |
| FFmpeg | RTSP menjadi MP4 browser | Hanya server |

Browser tidak terhubung langsung ke PostgreSQL atau RTSP. Server memverifikasi login, membaca metadata kamera, serta mendekripsi URL RTSP hanya saat dibutuhkan proses video.

Saat ini login dan inventaris kamera sudah menggunakan PostgreSQL. Tabel laporan, riwayat, pengaturan, dan sesi disediakan sebagai fondasi pengembangan lanjutan.
