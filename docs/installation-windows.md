# Instalasi di Windows

## Prasyarat

- Node.js 22+
- PostgreSQL 17 dan pgAdmin 4
- FFmpeg
- Hak administrator Windows untuk service dan firewall

## Database

1. Pasang PostgreSQL dan atur `listen_addresses = 'localhost'` pada `postgresql.conf`.
2. Restart service PostgreSQL.
3. Pada pgAdmin, buat role aplikasi dan database sebagai eksekusi terpisah:

```sql
CREATE ROLE cctv_app LOGIN PASSWORD 'GANTI_DENGAN_SANDI_KUAT';
CREATE DATABASE cctv_grid_map OWNER cctv_app;
```

`CREATE DATABASE` tidak boleh dijalankan dalam transaction block.

## Konfigurasi aplikasi

Salin `.env.example` menjadi `.env`:

```dotenv
DATABASE_URL=postgresql://cctv_app:SANDI_TERENKODE@127.0.0.1:5432/cctv_grid_map
SESSION_SECRET=nilai-rahasia-acak
RTSP_ENCRYPTION_KEY=base64-32-byte
BOOTSTRAP_ADMIN_EMAIL=admin@organisasi.local
BOOTSTRAP_ADMIN_PASSWORD=kata-sandi-minimal-12-karakter
```

`RTSP_ENCRYPTION_KEY` harus Base64 tepat 32-byte. Buat dari PowerShell:

```powershell
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
[Convert]::ToBase64String($bytes)
$rng.Dispose()
```

Lalu jalankan `npm install`, `npm run db:migrate`, `npm run db:bootstrap`, dan `npm start`. Jangan membagikan isi `.env`.
