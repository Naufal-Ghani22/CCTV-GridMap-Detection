# Database dan pgAdmin

Database pusat bernama `cctv_grid_map`. Di pgAdmin: `Servers` → `CCTV Local` → `Databases` → `cctv_grid_map` → `Schemas` → `public` → `Tables`. Bila belum muncul, refresh **Databases**.

| Tabel | Fungsi |
| --- | --- |
| `users` | Akun aplikasi dan hash kata sandi |
| `cameras` | Metadata serta koordinat CCTV |
| `camera_streams` | URL RTSP terenkripsi |
| `reports` | Laporan gangguan |
| `activity_history` | Aktivitas audit |
| `settings` | Pengaturan bersama |
| `sessions` | Digest sesi login |

Lihat data dengan klik kanan tabel → **View/Edit Data** → **All Rows**. Jangan mengubah `password_hash`, `encrypted_rtsp`, atau `token_hash` secara manual.

## Backup dan restore

```powershell
pg_dump --format=custom --file cctv_grid_map.backup --dbname cctv_grid_map
pg_restore --clean --if-exists --dbname cctv_grid_map cctv_grid_map.backup
```

Backup database tidak mencakup `.env`; simpan file tersebut melalui saluran rahasia terpisah. Jalankan `npm run db:smoke` untuk memastikan instalasi baru berisi satu admin tanpa CCTV, laporan, atau riwayat.
