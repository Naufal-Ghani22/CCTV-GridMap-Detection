# Referensi API

Respons tidak boleh memuat kata sandi, `DATABASE_URL`, maupun URL RTSP tersimpan.

| Metode | Endpoint | Fungsi |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Login email dan kata sandi |
| `GET` | `/api/auth/session` | Pengguna sesi saat ini |
| `POST` | `/api/auth/logout` | Keluar |
| `GET` | `/api/cameras` | Daftar kamera untuk pengguna login |
| `POST` | `/api/cameras` | Menambah kamera, admin saja |
| `POST` | `/api/ping` | Ping satu alamat IPv4 |
| `POST` | `/api/streams` | Sesi RTSP sementara |
| `GET` / `DELETE` | `/api/streams/:token` | Baca atau tutup tayangan |

Status umum: `200` berhasil, `201` dibuat, `400` input invalid, `401` belum login, `403` bukan admin, `404` tidak ditemukan, `409` ID kamera duplikat, dan `503` komponen tidak tersedia.
