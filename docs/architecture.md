# Arsitektur Sistem

```text
Browser petugas ── HTTP LAN :8080 ──> Node.js / CCTV Grid Map
                                            │
                                            ├── PostgreSQL :5432 (localhost saja)
                                            ├── Monitor ping ── ICMP ──> Kamera & NVR LAN
                                            ├── FFmpeg ── RTSP ──> Kamera/NVR LAN
                                            └── File denah dan antarmuka web
Browser petugas <── Server-Sent Events /api/events (pembaruan realtime)

pgAdmin (administrator lokal) ──> PostgreSQL :5432
```

| Komponen | Fungsi | Akses |
| --- | --- | --- |
| Browser | Peta, arah kamera, inventaris, laporan, alarm, live view | Petugas LAN |
| Node.js | Web, autentikasi, API, monitor ping, SSE, jembatan video | Port 8080 LAN |
| PostgreSQL | Pengguna, kamera, stream terenkripsi, laporan, riwayat, sesi | Hanya localhost |
| pgAdmin | Administrasi database | Administrator server |
| FFmpeg | RTSP menjadi MP4 browser | Hanya server |

Browser tidak terhubung langsung ke PostgreSQL atau RTSP. Server memverifikasi login, membaca metadata kamera, serta mendekripsi URL RTSP hanya saat dibutuhkan proses video.

Semua data bersama (akun, CCTV, laporan, riwayat, pengaturan NVR/area/denah, sesi) tersimpan di PostgreSQL. Browser hanya menyimpan preferensi tampilan (tema, bunyi alarm, lapisan peta, lantai terakhir) di `localStorage`.

## Kode server

| Berkas | Isi |
| --- | --- |
| `server.js` | Tabel rute, kontrol akses, aset statis, start monitor |
| `routes/*.js` | Handler per domain: `users`, `cameras`, `reports`, `history`, `settings`, `network` |
| `lib/monitor.js` | Ping berkala (maks. 8 bersamaan), transisi online/offline |
| `lib/events.js` | Hub Server-Sent Events |
| `lib/media.js` | Ping OS dan jembatan FFmpeg (sesi tayangan, batas, kedaluwarsa) |
| `lib/websocket.js` | WebSocket satu arah untuk grid View |
| `lib/validate.js` | Validasi input CCTV |
| `lib/http.js` | JSON, cookie, header keamanan |

Setiap perubahan data memanggil `hub.broadcast(jenis)`; browser lalu memuat ulang data jenis itu saja.

Tayangan tunggal diputar sebagai `<video src>` biasa (HTTP). Grid View memakai WebSocket ke Media Source Extensions, karena browser hanya membuka 6 koneksi HTTP/1.1 per server untuk semua tab: lima tayangan HTTP saja sudah membuat permintaan API lain menunggu.
