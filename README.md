# CCTV Grid Map

Prototipe pengelolaan CCTV bandara dengan denah SVG interaktif.

## Menjalankan aplikasi di jaringan lokal

Pastikan Node.js dan FFmpeg terpasang, lalu jalankan `npm start` di folder proyek. Server akan berjalan pada port `8080` dan menampilkan alamat untuk komputer ini serta alamat LAN yang bisa dibuka dari perangkat lain pada jaringan yang sama. Jika Windows Firewall meminta izin, izinkan akses pada jaringan privat.

Buka alamat yang dicetak server, misalnya `http://192.168.1.10:8080`. Biarkan terminal server tetap berjalan selama aplikasi digunakan. Jika port 8080 sudah dipakai, jalankan `$env:PORT=8081; npm start` di PowerShell dan gunakan port yang tercetak.

Untuk menguji CCTV, masuk sebagai admin, buka **Pengaturan sistem** → **Tayangan kamera**, pilih CCTV, isi **Alamat IP**, lalu tekan **Ping IP**. Hijau **Aktif** berarti alamat tersebut merespons satu ping ICMP dari komputer server. Waktu pemeriksaan dan latensi ditampilkan; hasil ini bukan pemantauan terus menerus dan tidak memastikan video kamera dapat dibuka.

Untuk menampilkan video, tempel URL `rtsp://` dari administrator pada kolom **URL tayangan**, simpan konfigurasi, lalu buka **Perangkat** → **Tayangan**. Server mengubah RTSP menjadi MP4 terfragmentasi yang dapat diputar browser. URL pemutar menggunakan token sesi sementara sehingga username dan password kamera tidak tampil pada alamat video.

Server ini ditujukan untuk jaringan lokal tepercaya. Aplikasi masih menggunakan akun demo dan menyimpan data perangkat di browser, sehingga jangan meneruskan port 8080 ke internet.

## Database PostgreSQL lokal

PostgreSQL dan pgAdmin dipasang pada komputer server. PostgreSQL harus hanya mendengarkan `127.0.0.1` dan `::1`; browser petugas hanya mengakses web melalui port `8080`.

Salin `.env.example` menjadi `.env`, lalu isi URL koneksi role aplikasi, dua secret acak, dan akun administrator awal. Jangan menyimpan `.env` di Git atau membagikannya melalui chat. Setelah koneksi database tersedia, jalankan `npm run db:migrate` dan `npm run db:bootstrap` untuk membuat skema kosong dan akun admin pertama.

## Akun demo

- Admin: `admin@airport.local` / `Admin123!`
- Pengguna: `user@airport.local` / `User123!`

## Fitur

- Ringkasan kondisi perangkat
- Peta CCTV berbasis SVG
- Pengaturan posisi dan arah pandang kamera
- Inventaris perangkat
- Hak akses admin dan pengguna
- Laporan gangguan serta riwayat aktivitas
- Impor denah SVG dari Figma
- Konfigurasi NVR dan URL tayangan
- Tayangan RTSP langsung melalui jembatan FFmpeg
- Ping ICMP alamat CCTV dengan hasil dan waktu pemeriksaan

## Catatan

Versi ini menyimpan data di browser. Untuk penggunaan produksi, pindahkan autentikasi dan data ke backend, gunakan PostgreSQL, lalu hubungkan NVR melalui jaringan internal.
