# CCTV Grid Map

Sistem web ruang kontrol untuk CCTV bandara: titik dan arah kamera pada denah, pemantauan ping otomatis seluruh CCTV dan NVR, alarm offline, laporan gangguan, dan tayangan RTSP di browser. Node.js melayani pengguna LAN, sedangkan PostgreSQL menyimpan data pusat pada komputer server.

## Mulai cepat

1. Pasang Node.js, PostgreSQL 17, pgAdmin 4, dan FFmpeg pada komputer server.
2. Salin `.env.example` menjadi `.env`, lalu isi semua nilai secara lokal.
3. Jalankan `npm install`, `npm run db:migrate`, dan `npm run db:bootstrap`.
4. Jalankan `npm start`, kemudian buka alamat LAN yang dicetak server.

PostgreSQL hanya boleh mendengarkan `127.0.0.1` dan `::1`. Pengguna biasa cukup memakai browser, tanpa PostgreSQL atau pgAdmin.

## Dokumentasi

- [Arsitektur](docs/architecture.md)
- [Instalasi Windows](docs/installation-windows.md)
- [Operasi CCTV](docs/operations.md)
- [Database dan pgAdmin](docs/database.md)
- [API](docs/api.md)
- [Keamanan](docs/security.md)
- [Deployment bandara](docs/deployment-airport.md)
- [Troubleshooting](docs/troubleshooting.md)

## Perintah penting

```powershell
npm install
npm run db:migrate
npm run db:bootstrap
npm start
npm test                 # unit + API (memakai PostgreSQL lokal dari .env)
npm run test:e2e         # UI di Edge headless
npm run db:smoke         # cek instalasi baru masih kosong
npm run db:reset-admin   # setel ulang akun admin dari .env
```

Opsi `.env` tambahan: `PORT`, `MONITOR_INTERVAL_SEC`, `MAX_STREAMS`, `STREAM_VIDEO_CODEC=copy`, `MONITOR_DISABLED=1`.

`.env` berisi rahasia server dan tidak boleh masuk Git, backup database, atau chat.
