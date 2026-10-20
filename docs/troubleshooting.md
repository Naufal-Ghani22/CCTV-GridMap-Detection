# Troubleshooting

## Web tidak terbuka

Pastikan `npm start` berjalan, gunakan alamat LAN yang dicetak terminal, dan periksa firewall Windows pada profil privat.

## Login gagal

Gunakan email dan kata sandi akun Anda. Pesan "Terlalu banyak percobaan" berarti tunggu hingga 15 menit. Pastikan PostgreSQL hidup dan `DATABASE_URL` pada `.env` valid. Jika akun admin tidak diketahui, perbarui `BOOTSTRAP_ADMIN_EMAIL` dan `BOOTSTRAP_ADMIN_PASSWORD` di `.env`, lalu jalankan `npm run db:reset-admin`.

## Tiba-tiba kembali ke layar login

Sesi berakhir (12 jam), kata sandi diganti di komputer lain, atau admin menonaktifkan akun. Masuk kembali.

## "Menyambung ulang…" di bilah atas

Browser kehilangan koneksi realtime ke server (server dimatikan, jaringan putus). Browser menyambung ulang otomatis dan memuat ulang data setelah tersambung. Bila terus muncul, periksa server dan proxy/antivirus yang memblokir `text/event-stream`.

## Database tidak tersedia

Server tetap hidup dan membalas `503 database_unavailable`. Pastikan service PostgreSQL berjalan, variabel `.env` terisi, dan `RTSP_ENCRYPTION_KEY` adalah Base64 32-byte. Setelah memperbarui aplikasi, selalu jalankan `npm run db:migrate`.

## Semua CCTV tiba-tiba offline

Biasanya server kehilangan rute ke subnet kamera, bukan kamera mati semua. Cek status **Server NVR** di Ringkasan, `ping` dari komputer server, gateway, dan VLAN. Monitor menandai offline setelah 2 kali gagal berturut-turut.

## Kamera tidak bisa ping/live

Periksa IP, gateway, VLAN, rute antar-subnet, firewall, port RTSP 554, kredensial RTSP, dan FFmpeg (`ffmpeg -version`). Ping sukses hanya berarti ICMP tersedia. "Batas tayangan bersamaan tercapai" berarti tutup tayangan lain atau naikkan `MAX_STREAMS`. Untuk kamera H.264, `STREAM_VIDEO_CODEC=copy` sangat menghemat CPU.

## Denah impor ditolak

Ekspor ulang SVG tanpa skrip/interaksi dan pastikan elemen `<svg>` memiliki `viewBox`.

## `CREATE DATABASE cannot run inside a transaction block`

Jalankan `CREATE ROLE` dan `CREATE DATABASE` sebagai dua eksekusi terpisah di Query Tool pgAdmin.
