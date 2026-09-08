# Client Promosi Lite

Layanan promosi Telegram dengan dua pilihan eksekutor: Userbot Promosi memakai akun buyer untuk Auto Sebar dan Auto Komen MF, sedangkan Auto Sebar Akun Admin memakai worker milik admin secara 1:1 per buyer dan tidak memiliki akses Auto Komen.

## Yang sudah dibangun

- Dashboard buyer dan panel admin setup buyer.
- Inventory worker: tambah, login/login ulang, assign, pantau health runner, nonaktifkan, putuskan session, dan hapus record.
- Pergantian worker memakai proses draining: akun lama menyelesaikan leave sebelum kembali tersedia, sementara akun baru menyiapkan target buyer.
- Konfigurasi Auto Sebar dan Auto Komen berbasis approval atau otomatis.
- Retensi siap dijalankan: kandidat approval 48 jam, anti-duplikat 7 hari, riwayat sebar 30 hari / 100 terakhir.
- Paket terpisah untuk Auto Sebar Akun Admin dan Userbot Promosi; masa aktif serta kapasitas LPM mengikuti paket yang dipilih.
- Pembayaran Pakasir: buyer diarahkan ke halaman pembayaran, lalu produk yang dibeli aktif hanya setelah webhook diverifikasi ulang ke Transaction Detail API.

## Menjalankan

1. `cp .env.example .env`
2. `npm install`
3. `npm run dev`

Mode lokal memakai data di folder data. Untuk mencoba dashboard demo—termasuk saat dibuka lewat ngrok—isi ALLOW_DEMO=true. Mode ini hanya untuk testing lokal, jangan pernah dinyalakan di production.

## Menyambungkan ke Telegram

1. Deploy aplikasi ini ke domain HTTPS, lalu isi MINIAPP_URL dengan alamat tersebut dan BOT_TOKEN dengan token bot client.
2. Deploy ulang. Saat bot hidup, ia memasang tombol menu **Buka layanan** dan tombol /start ke Mini App secara otomatis.
3. Buyer membuka bot lalu menekan tombol itu. Mini App membaca identitas Telegram dari sesi yang dibuka dan server memverifikasinya dengan BOT_TOKEN.
4. Saat admin membuat buyer, simpan Telegram ID buyer yang tepat. Itu yang mengikat akun Telegram buyer ke layanannya.

Jangan aktifkan ALLOW_DEMO di production. Alur login Telegram (OTP) untuk Auto Komen sudah tersedia dari Mini App.

## Menyiapkan Supabase untuk Railway

Runtime memakai Supabase Postgres untuk seluruh data operasional dan session Telegram terenkripsi. Session tidak lagi bergantung pada disk Railway yang bisa hilang saat redeploy.

1. Buat project Supabase, lalu ambil `SUPABASE_URL`, **Secret key**, dan Postgres connection string dari Dashboard **Connect**.
2. Isi ketiganya di environment lokal sementara, lalu jalankan `npm run db:migrate` sekali. Perintah ini hanya membuat tabel kosong `app_state` dan `app_sessions` serta mengaktifkan RLS.
3. Di Railway, isi `SUPABASE_URL` dan `SUPABASE_SECRET_KEY` (tidak perlu `SUPABASE_DB_URL` setelah migrasi selesai), bersama semua environment aplikasi lainnya.
4. Deploy saat lo sudah siap. Bila dua env runtime Supabase belum lengkap, aplikasi sengaja tetap memakai file lokal agar local development tidak terganggu.

Jangan pakai Publishable/anon key untuk server. Secret key hanya untuk backend dan tidak boleh masuk ke frontend, git, atau chat.

## Mengaktifkan pembayaran Pakasir

Selama KYC Pakasir belum selesai, biarkan `SELF_SERVICE_SUBSCRIPTIONS=false`. Buyer akan melihat arahan untuk menghubungi admin, checkout dan webhook aktivasi otomatis ditutup, sementara admin tetap bisa memberi akses dari Panel Pelanggan. Saat Pakasir production siap, ubah variable itu menjadi `true` lalu deploy ulang.

1. Buat proyek di Pakasir, lalu isi `PAKASIR_PROJECT` (slug proyek) dan `PAKASIR_API_KEY` di environment server.
2. Di pengaturan proyek Pakasir, isi Webhook URL: `https://domain-miniapp-lo/api/payments/pakasir/webhook`.
3. Untuk local test, pakai URL ngrok yang aktif sebagai domain Mini App dan Webhook URL, lalu gunakan mode Sandbox/Pembayaran simulasi Pakasir.

Paket tidak pernah aktif dari halaman kembali pembayaran. Sistem hanya mengaktifkan paket setelah Pakasir mengirim webhook `completed` dan status transaksi cocok saat dicek ulang ke API Pakasir.

Isi `BOT_USERNAME` tanpa `@` agar tombol kembali Pakasir memakai deep link Telegram dan membuka Main Mini App lagi dengan status pembayaran buyer. Pastikan Main Mini App bot sudah diatur di BotFather.

## Siap deploy ke Railway

Project sudah membawa `railway.toml`: Railpack menjalankan `npm run build`, aplikasi dijalankan dengan `npm start`, health check memakai `/api/health`, dan deployment lama dihentikan sebelum instance baru mulai polling bot. Ini penting karena satu token bot tidak boleh dipoll oleh dua instance bersamaan.

Sebelum deploy, isi variables Railway berikut tanpa memasukkannya ke Git: `BOT_TOKEN`, `BOT_USERNAME`, `MINIAPP_URL`, `ADMIN_TELEGRAM_IDS`, `PAKASIR_PROJECT`, `PAKASIR_API_KEY`, `WITHDRAW_NOTIFY_TELEGRAM_ID`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `WORKER_SESSION_KEY`, `LPM_ADAPTER_TOKEN`, `SUPABASE_URL`, dan `SUPABASE_SECRET_KEY`. Pastikan `ALLOW_DEMO=false`.

Setelah Railway menghasilkan domain publik, masukkan domain tersebut sebagai `MINIAPP_URL`, domain Mini App di BotFather, dan webhook Pakasir: `https://domain-lo/api/payments/pakasir/webhook`, lalu deploy ulang satu kali agar menu bot memakai URL final.

## Tarik saldo

Saldo dari pembayaran lunas menjadi siap tarik pada H+1 pukul 12.00 WIB. Admin client bisa mengajukan seluruh saldo yang siap tarik mulai pukul 12.30 WIB; minimum pengajuan Rp30.000 dan potongan admin Rp5.000.

Isi `WITHDRAW_NOTIFY_TELEGRAM_ID` dengan ID Telegram pengelola penarikan (bukan username). Akun tersebut harus membuka bot client lalu menjalankan `/start` sekali. Saat client menekan Tarik saldo, bot mengirim nominal bruto, potongan, dan nominal yang perlu dikirim. Pengelola menekan **Tandai sudah dikirim** di notifikasi untuk menutup pengajuan dan memberi kabar ke client.
