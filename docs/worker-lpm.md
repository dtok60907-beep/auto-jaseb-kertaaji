# Worker LPM

Isi `.env`:

```env
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
WORKER_SESSION_KEY=
LPM_ADAPTER_TOKEN=
```

`WORKER_SESSION_KEY` dan `LPM_ADAPTER_TOKEN` wajib berupa rahasia panjang dan berbeda.

Tambahkan worker dari Panel Admin lalu pilih **Hubungkan akun**. Admin memasukkan nomor, kode Telegram, dan password 2FA bila diperlukan langsung dari Mini App. Username dibaca otomatis dari akun yang berhasil terhubung.

Server menjalankan worker dan membaca antrean join/keluar otomatis. Saat Supabase aktif, session tersimpan terenkripsi di database; saat local tanpa Supabase, session sementara tersimpan di `data/worker-sessions.json`. Keduanya tidak ikut git.

## Status operasional

Status penugasan worker dan status koneksi Telegram dipisahkan. Worker hanya dapat dipilih buyer ketika tidak dinonaktifkan, belum dipakai buyer lain, memiliki session, dan status koneksinya `CONNECTED`.

Panel Admin menampilkan status koneksi, runner, buyer pemilik, waktu koneksi terakhir, dan alasan masalah. Session yang revoked atau terkena concurrent usage berubah menjadi `RECONNECT_REQUIRED` dan tidak mengambil job baru sampai admin melakukan login ulang.

Worker yang tidak sedang dipakai buyer tetap menyimpan session tetapi runner-nya dimatikan untuk menghemat RAM. Saat worker di-assign, server menyalakan runner otomatis. Runner mengirim heartbeat setiap 30 detik; heartbeat yang hilang selama dua menit memicu restart dengan backoff.

Saat akun buyer diganti, worker lama tidak langsung dilepas. Target lama masuk status `REMOVING` agar akun lama keluar dari grup, sedangkan worker baru mendapat target `CONNECTING`. Worker lama kembali `AVAILABLE` setelah semua pekerjaan leave selesai.

Worker yang masih assigned tidak bisa diputus, dinonaktifkan, atau dihapus. Jika session-nya bermasalah, lakukan login ulang. Jika buyer perlu segera berjalan, pilih worker sehat lain dari halaman Pelanggan; worker lama tetap harus dipulihkan agar dapat menyelesaikan leave.
