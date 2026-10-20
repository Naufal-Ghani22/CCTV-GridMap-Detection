# Operasi Harian

## Memulai layanan

Jalankan `npm start` pada folder proyek dan biarkan terminal tetap terbuka. Gunakan alamat LAN yang dicetak server. Izinkan port 8080 hanya pada profil jaringan Windows privat. Saat start, server juga menyalakan **monitor ping** untuk semua CCTV dan NVR.

## Akun dan peran

| Peran | Bisa |
| --- | --- |
| Administrator | Semua, termasuk edit peta, CCTV, NVR, denah, area, akun, dan menyelesaikan laporan |
| Operator | Memantau peta, ping, tayangan, membuat laporan, melihat riwayat |

Login pertama memakai `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`. Setelah itu buat akun tiap petugas di **Pengaturan → Akun petugas**; jangan berbagi akun admin. Kata sandi minimal 12 karakter. Menonaktifkan akun langsung mengakhiri sesinya. Jika kata sandi admin lupa, isi kembali kedua nilai di `.env` lalu jalankan `npm run db:reset-admin`.

## Layar ruang kontrol

- **Ringkasan**: jumlah CCTV, persentase normal, offline, laporan aktif, status NVR, sebaran per lantai, dan aktivitas terbaru. Klik kartu untuk membuka daftar yang sesuai.
- **Pita merah "N CCTV offline"** di bilah atas muncul saat ada CCTV offline. Klik untuk langsung ke peta dengan filter offline.
- Saat sebuah CCTV berubah offline, semua komputer menampilkan notifikasi dan bunyi alarm (ikon lonceng untuk mematikan bunyi di komputer itu).
- **Tersinkron** berarti browser menerima pembaruan realtime. Perubahan dari komputer lain muncul tanpa reload.
- Tema gelap/terang diatur per komputer lewat ikon matahari/bulan.

## Membaca peta

- Titik hijau = normal, kuning dengan **!** = perlu perhatian, merah berdenyut dengan **×** = offline.
- **Kerucut** menunjukkan arah dan cakupan kamera. Garis putus-putus = sumbu arah. 0° = atas denah (lihat kompas kiri atas).
- Panel kanan berisi daftar CCTV pada lantai aktif, dikelompokkan per status, dengan arah (mis. `TL 45°`) dan latensi ping. Arahkan kursor ke baris untuk menyorot titiknya; klik untuk membuka detail.
- Peta mini kiri bawah menunjukkan posisi tampilan; klik atau seret untuk berpindah area.
- Matikan lapisan **Arah** atau **Label** bila peta padat.

## Menambah CCTV

1. **Peta** → **Tambah CCTV**, lalu klik lokasi kamera pada denah.
2. Isi area, lokasi rinci, merek, model, nomor seri, IP, dan URL RTSP bila ada. Lantai dan posisi X/Y terisi dari klik.
3. Simpan. Mode edit langsung aktif; atur arah seperti di bawah.

## Mengatur posisi dan arah (mode edit, admin)

Tekan **Edit peta** (atau `E`), pilih CCTV, lalu:

| Ingin | Caranya |
| --- | --- |
| Memindah titik | Seret ikon kamera, atau panah keyboard (Shift = lebih jauh) |
| Mengubah arah & jangkauan | Seret **titik biru di ujung kerucut** ke tempat yang dilihat kamera; atau seret jarum dial di panel; tombol U/TL/T/…; `Q`/`W` (±5°, Shift ±15°) |
| Mengubah lebar sudut pandang | Seret **titik putih di sisi kerucut**; slider "Sudut pandang"; `[` / `]` |
| Mengubah jangkauan saja | Slider "Jangkauan"; `,` / `.` |
| Membatalkan | **Urungkan** atau `Ctrl+Z` |

Perubahan tersimpan otomatis ke database (indikator "Tersimpan HH.MM") dan langsung terlihat di komputer lain.

## Ping, monitor, dan NVR

- Monitor mem-ping semua CCTV ber-IP dan NVR setiap interval (bawaan 60 detik, ubah di **Pengaturan → Pemantauan jaringan**). CCTV ditandai offline setelah 2 kali gagal berturut-turut dan kembali normal otomatis saat merespons.
- Daftarkan semua NVR/recorder di **Pengaturan → Server NVR**, lalu pilih NVR pada data CCTV agar terlihat kamera mana yang bergantung pada NVR tertentu.
- Tombol **Ping** di panel detail menguji satu CCTV saat itu juga.
- Ping hijau berarti server menerima balasan ICMP; ini tidak menjamin RTSP bekerja. Server harus menjangkau subnet kamera (rute antar-VLAN bila berbeda subnet).

## Laporan gangguan

Operator membuat laporan dari panel CCTV (**Lapor**) atau halaman **Laporan**. CCTV yang dilaporkan otomatis berstatus *perlu perhatian* (atau *offline* untuk masalah "Perangkat offline"). Admin memajukan status **Baru → Dikerjakan → Selesai**; saat laporan terakhir CCTV selesai, statusnya kembali normal.

## Denah

Denah bawaan (`maps/*.svg`) adalah peta indoor yang digambar ulang dari PDF CAD dengan `tools/stylize_map.py`: tapak gedung, petak ruangan, dan garis tembok seragam, tanpa furnitur atau teks (lihat `tools/README.md`). Untuk denah lain, impor SVG di **Pengaturan → Denah lantai**.

## Pintasan keyboard

`/` atau `Ctrl+K` cari CCTV · `1`–`6` pindah halaman · `G` ganti lantai · `N`/`P` CCTV berikut/sebelumnya · `+`/`-`/`0` zoom · `F` layar penuh · `Esc` tutup · `?` bantuan.
