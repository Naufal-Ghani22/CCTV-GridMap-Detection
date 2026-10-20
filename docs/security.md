# Keamanan

- Simpan `.env` hanya pada komputer server; file ini sudah diabaikan Git.
- Gunakan kredensial terpisah untuk PostgreSQL superuser, `cctv_app`, pgAdmin, dan setiap petugas web. Jangan berbagi akun admin.
- Jangan buka port 5432 ke LAN; PostgreSQL hanya pada localhost.
- Sesi login memakai cookie `HttpOnly` dan `SameSite=Strict`, berlaku 12 jam. Database hanya menyimpan digest SHA-256 token. Sesi kedaluwarsa dibersihkan tiap 15 menit.
- Login dibatasi 5 percobaan per 15 menit per IP+email, dan 30 per IP.
- Kata sandi disimpan memakai `scrypt` dengan salt acak, minimal 12 karakter. Mengganti kata sandi mengakhiri sesi di komputer lain; menonaktifkan akun mengakhiri semua sesinya.
- Semua API selain login/logout butuh sesi. Perubahan peta, CCTV, NVR, denah, area, dan akun hanya untuk admin. Minimal satu admin aktif selalu dipertahankan.
- URL RTSP disimpan memakai AES-256-GCM dan hanya didekripsi di server saat membuka tayangan. Browser hanya mengirim kode CCTV, tidak pernah URL RTSP. Log FFmpeg menyamarkan URL RTSP.
- Ping dan RTSP hanya ke IPv4 privat (10/8, 172.16/12, 192.168/16). Ping maks. 8 bersamaan; tayangan maks. `MAX_STREAMS` (bawaan 8) dan 4 per pengguna.
- Setiap respons membawa `Content-Security-Policy` (tanpa skrip inline/eksternal), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, dan `X-Content-Type-Options: nosniff`. Aplikasi tidak memuat font atau skrip dari internet.
- Denah SVG impor disaring di browser dan ditolak server bila memuat skrip, `on*=`, `foreignObject`, atau `javascript:`.
- Semua perubahan tercatat di `activity_history` beserta pelakunya.
- Jangan letakkan URL RTSP, kata sandi, kunci, atau `.env` pada screenshot, chat, tiket, atau GitHub.

`SESSION_SECRET` tidak lagi diperlukan (token sesi acak 256-bit). Variabel ini aman dihapus dari `.env`.

Jika sebuah rahasia pernah terkirim ke chat atau repositori, segera ganti rahasia tersebut. Mengganti `RTSP_ENCRYPTION_KEY` berarti URL RTSP lama perlu dimasukkan kembali.
