# Alat denah

Membuat `maps/*.svg` dari PDF denah CAD. Butuh Python 3.10+ dengan `pip install pymupdf opencv-python numpy`.

## Tembok saja (dipakai aplikasi)

```powershell
python tools/extract_walls.py "Telephone GF-Save as (1).pdf" maps/ground-floor.svg --floor gf --label "Denah lantai dasar" --clip 30,292,1172,462 --exclude 1065,420,1180,456
python tools/extract_walls.py "Telephone FF-Save as (1).pdf" maps/first-floor.svg --floor ff --label "Denah lantai 1" --clip 126,230,750,340
```

- `--clip x0,y0,x1,y1`: area gedung dalam poin PDF (seperti tampil di viewer, sudah memperhitungkan rotasi halaman). Buang baris as, legenda, dan diagram alur.
- `--exclude`: area yang dibuang di dalam clip (mis. legenda).
- Hasil: `fp-solid` (tembok dan kolom terisi) dan `fp-glass` (kaca, kusen, partisi tipis).
- Atur `--close` (celah dua garis tembok yang disatukan, bawaan 0,35 pt), `--open` (pita tertipis yang dipertahankan, 0,15 pt), dan `--max-thickness` (bidang lebih tebal dianggap arsir, 1,2 pt) bila PDF lain berskala berbeda. `--preview mask.png` menyimpan hasil antara.

Cara kerja: semua garis gelap kecuali layer teks, furnitur, sanitair, tangga, peralatan, dan arsir digambar ke kanvas resolusi tinggi. Dua garis tembok disatukan (closing), garis tunggal tipis dihapus (opening), bidang tebal (arsir) dan bintik kecil dibuang, lalu pita tembok dilacak kembali menjadi poligon vektor.

## Denah lengkap (opsional)

`tools/pdf_to_svg.py` menyalin semua vektor (furnitur, teks, panah alur) per kelas warna. File jauh lebih besar (±6 MB) dan ramai; tidak dipakai bawaan.

## Setelah mengganti denah

Posisi CCTV disimpan dalam persen terhadap denah. Bila `--clip` berubah, posisi lama bergeser. `db/remap-floorplans.js` memindahkan posisi sekali (dijalankan oleh `npm run db:migrate`, ditandai `settings.map_frame`). Untuk perubahan clip berikutnya, tambahkan versi dan bingkai baru di file itu.
