# Operasi Harian

## Memulai layanan

Jalankan `npm start` pada folder proyek dan biarkan terminal tetap terbuka. Gunakan alamat LAN yang dicetak server. Izinkan port 8080 hanya pada profil jaringan Windows privat.

## Login

Gunakan nilai `BOOTSTRAP_ADMIN_EMAIL` dan `BOOTSTRAP_ADMIN_PASSWORD` yang dipakai ketika bootstrap pertama kali dijalankan. Mengubah `.env` setelah itu tidak mengubah akun yang sudah tersimpan di database.

## Menambah titik CCTV

1. Masuk sebagai administrator.
2. Buka **Peta** → **Tambah CCTV**.
3. Isi ID unik, area, lokasi, IP, koordinat X/Y, arah, dan informasi perangkat.
4. Isi URL RTSP bila live view diperlukan, lalu simpan.

Metadata disimpan di PostgreSQL. URL RTSP dienkripsi sebelum disimpan dan tidak dikembalikan oleh daftar kamera. Area yang tersedia: **Checkin Keberangkatan**, **Kedatangan**, dan **Boarding**.

## Ping dan tayangan

Ping hijau berarti server menerima satu balasan ICMP; ini tidak menjamin RTSP bekerja. Untuk live view, server harus menjangkau IP kamera dan port RTSP. Jika server `192.168.17.x` dan kamera `192.168.1.x`, harus ada rute antar-subnet atau keduanya perlu berada pada jaringan yang sama.
