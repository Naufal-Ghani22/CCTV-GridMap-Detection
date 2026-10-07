# Keamanan

- Simpan `.env` hanya pada komputer server; file ini sudah diabaikan Git.
- Gunakan kredensial terpisah untuk PostgreSQL superuser, `cctv_app`, pgAdmin, dan admin web.
- Jangan buka port 5432 ke LAN; PostgreSQL hanya pada localhost.
- Sesi login memakai cookie `HttpOnly` dan `SameSite=Strict`.
- Kata sandi disimpan menggunakan `scrypt` dengan salt acak.
- URL RTSP disimpan memakai AES-256-GCM.
- Database menyimpan digest token sesi, bukan token browser asli.
- Jangan letakkan RTSP URL, kata sandi, kunci, atau `.env` pada screenshot, chat, tiket, atau GitHub.

Jika sebuah rahasia pernah terkirim ke chat atau repositori, segera ganti rahasia tersebut. Mengganti `RTSP_ENCRYPTION_KEY` berarti data stream lama perlu dimasukkan kembali.
