# Troubleshooting

## Web tidak terbuka

Pastikan `npm start` berjalan, gunakan alamat LAN yang dicetak terminal, dan periksa firewall Windows pada profil privat.

## Login gagal

Gunakan email dan kata sandi yang dipakai pada bootstrap awal. Pastikan PostgreSQL hidup dan `DATABASE_URL` pada `.env` valid.

## Database tidak tersedia

Pastikan service PostgreSQL berjalan, lima variabel `.env` terisi, dan `RTSP_ENCRYPTION_KEY` adalah Base64 32-byte. Jalankan `npm run db:migrate` jika perlu.

## Kamera tidak bisa ping/live

Periksa IP, gateway, VLAN, rute antar-subnet, firewall, port RTSP, kredensial RTSP, dan FFmpeg. Ping sukses hanya berarti ICMP tersedia.

## `CREATE DATABASE cannot run inside a transaction block`

Jalankan `CREATE ROLE` dan `CREATE DATABASE` sebagai dua eksekusi terpisah di Query Tool pgAdmin.
