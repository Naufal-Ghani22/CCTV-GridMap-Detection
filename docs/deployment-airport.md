# Pemindahan ke Perangkat Bandara

Pindahkan folder proyek tanpa `.env`, `node_modules`, dan log; backup database; serta `.env` lewat kanal aman terpisah.

1. Gunakan IP statis untuk perangkat server bandara.
2. Pasang Node.js, PostgreSQL, pgAdmin, dan FFmpeg.
3. Batasi PostgreSQL pada localhost.
4. Pulihkan backup database atau buat database baru.
5. Salin `.env`, jalankan `npm install`, `npm run db:migrate`, dan `npm start`.
6. Buka port 8080 hanya untuk jaringan privat.
7. Dari komputer petugas, buka `http://IP_SERVER:8080`; pastikan port 5432 tidak dapat diakses.

Pemeriksaan penerimaan: login admin, data tampak sama dari dua browser, ping kamera dari server, satu live view berhasil, dan backup database serta `.env` tersimpan aman.
