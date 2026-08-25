# Handoff ke Codex — JASEB client-promosi-lite

Tanggal handoff: 2026-08-25 (WITA)
Repo: /Users/user/Desktop/JASEB oto kerta aji (branch main, bersih, SINKRON dengan origin/main)
Commit terakhir: 879fcc7 "Optimize managed userbot runners" (SUDAH dideploy, live di Railway)
Produksi: https://promosi-production.up.railway.app — status Online, bot ready, sehat

## KONTEKS: apa yang terjadi hari ini (urutan kronologis)

1. Produksi crash-loop berulang (proses mati diam-diam tiap 8-12 detik, NOL error
   di log aplikasi). Diagnosis final: OOM — kontainer kehabisan RAM karena arsitektur
   lama spawn 1 proses Node PER AKUN userbot (~100MB per akun) + server utama.
   Railway dashboard menampilkan "Out of memory". Owner upgrade ke plan HOBBY → masalah
   langsung reda.
2. Perbaikan yang sudah LIVE di produksi sekarang (commit 879fcc7):
   - reapOrphanedRunners(): pidfile data/comment-runner.pids (pid+host), bunuh runner
     yatim dari boot sebelumnya. Pid dari host/kontainer lain TIDAK PERNAH dikirimi sinyal.
   - Staggered spawn (scheduleStaggeredStarts, gap 4 detik).
   - Log "Memory usage" tiap 60 detik (rssMb/heapUsedMb/runners/userbotAccounts).
   - bot.catch() error boundary — tanpa ini SATU update bermasalah (mis. penerima
     block bot) me-reject bot.start() dan polling mati permanen walau HTTP sehat.
     Kejadian nyata hari ini: health = {"bot":"error: ... blocked by the user"} selamanya.
   - Cache teks store di src/database.ts (storeTextCache, TTL default 60s via env
     STORE_CACHE_TTL_MS) + skip PATCH kalau isi identik. Alasan: satu-satunya penulis
     store adalah proses server ini; sebelumnya tiap poll internal narik JSON 87KB
     ±500rbx/hari. Setelah cache: ~1.400 fetch/hari (-99,7%), latensi endpoint internal
     turun dari 1-2 detik ke milidetik.
3. Owner minta efisiensi cost ala project NEXO (repo /Users/user/Desktop/NEXO PROMOSI MINI APP)
   TANPA mengorbankan pengalaman user. Dari NEXO yang DIADOPSI:
   - Crash-cooldown per akun: RUNNER_CRASH_COOLDOWN_MS=90_000,
     RUNNER_DUPLICATED_COOLDOWN_MS=5*60_000 khusus AUTH_KEY_DUPLICATED.
   - Worker AVAILABLE (tanpa pemilik) tidak dispawn — session tetap disimpan,
     begitu di-assign reconcile otomatis nyalakan lagi.
   - Tameng unhandledRejection untuk TIMEOUT/FLOOD_WAIT_ (noise GramJS benign).
   - Login ulang oleh user MENGHAPUS cooldown (runnerRestartNotBefore.delete) supaya
     reconnect tetap responsif — JANGAN hilangkan ini.
   Yang TIDAK diadopsi (keputusan owner): governor/warmup/pacing (menunda kirim =
   merugikan user), fitur AI NEXO.

## KEADAAN ARSITEKTUR SEKARANG (yang WAJIB dipahami Codex)

Konsolidasi proses userbot sudah AKTIF (bukan parkir lagi):
- scripts/userbot-runner.ts = SATU proses host SEMUA akun buyer (saat ini 7 akun).
  Roster ditulis server ke data/userbot-roster.json (writeUserbotRoster),
  dibaca ulang tiap tick; akun keluar roster → sesi berhenti sendiri (REMOVED_FROM_ROSTER).
- startUserbotRunner() di server.ts:181 spawn host itu NOT detached (detached:false)
  — sengaja: SIGTERM server ikut mematikan semua koneksi Telegram, tidak ada yatim
  lintas deploy. JANGAN diubah jadi detached.
- Runner legacy per-akun (scripts/comment-runner.ts) masih ada sebagai jalur rollback;
  startCommentRunner/stopCommentRunner masih terdefinisi tapi jalur aktif sekarang lewat
  userbot-runner.ts. runBuyerSession(buyerId, isStillWanted) diekspor dan bisa dipakai
  per-akun bila dibutuhkan.
- Verifikasi live 11:41 UTC: rssMb=235, runners=1 (host gabungan), userbotAccounts=7.
  Sebelum konsolidasi: 6 proses × ~180MB ≈ 1GB+; sekarang total ~235MB. Ini yang
  bikin plan Hobby aman.

## PEKERJAAN YANG BELUM SELESAI (tugas Codex)

### A. Self-scheduling reconcile — HILANG saat commit, harus dipasang ulang
Di src/server.ts sekitar baris 1341 masih setInterval polos:
    const runnerReconcileInterval = setInterval(() => { reconcileRunnersSafely(); }, 30_000);
Ganti dengan pola self-scheduling ala NEXO (apps/engine/src/index.ts:241) supaya
reconcile yang lambat tidak pernah menumpuk invocation:
    let reconciling = false;
    const scheduleReconcileChain = () => { setTimeout(() => {
      if (reconciling || shuttingDown) { scheduleReconcileChain(); return; }
      reconciling = true;
      void Promise.resolve(reconcileRunnersSafely()).catch(() => undefined).finally(() => {
        reconciling = false; scheduleReconcileChain();
      });
    }, 30_000); };
    void scheduleReconcileChain();
Catatan penting: reconcileRunnersSafely() versi sekarang SUDAH punya mutex internalnya
sendiri ("satu rekonsiliasi pada satu waktu cukup; pemicu tambahan meminta satu putaran
lagi") — baca dulu implementasinya sebelum menyuntikkan flag kedua, jangan sampai dobel
mekanisme yang bertabrakan. Kalau mutex existing sudah cukup memutus penumpukan,
alternatif yang lebih bersih: hapus setInterval dan gantikan dengan chain di atas
TANPA flag tambahan. Interval 30 detik dipertahankan (jangan dinaikkan — dipakai juga
untuk menyalakan worker yang baru di-assign).

### B. Log siklus hidup akun (permintaan eksplisit owner)
Owner ingin aktivitas Auto Komen MF & Jasa Sebar sampai level konek akun TERBACA RAPI
di log seperti NEXO (🟢 konek / 🛑 stop / 💀 mati permanen + alasan). Saat ini:
- userbot-runner.ts sudah emit JSON lines: {"event":"userbot-connected","buyerId":...}
  dan {"event":"userbot-disconnected",...} via console.log, tapi server TIDAK meneruskan
  stdout child ke logger Fastify (stdio pipe hanya menampung stderr).
Tugas: di startUserbotRunner() (server.ts:188-207) tambahkan reader stdout:
  runner.stdout?.on("data", chunk => ...parse per baris JSON... app.log.info({...}))
dengan format log konsisten: { event, buyerId } dan pesan Indonesia singkat, mis:
"🟢 Akun userbot tersambung" / "🛑 Akun userbot terputus". Parse gagal → log mentah
sebagai warn, jangan di-drop. Selain itu pastikan endpoint
/api/internal/userbot-account-status (server.ts:~855) juga mencatat transisi
CONNECTED/RECONNECT_REQUIRED sebagai app.log.info (sekarang hanya mutasi state).

### C. Verifikasi setelah implementasi (WAJIB, jangan dilewati)
1. npm run build  → tsc --noEmit + vite build lolos
2. npm run test   → 10 test access.test.ts pass
3. JANGAN deploy sendiri. Deploy `railway up` WAJIB izin owner dulu.
4. Setelah deploy (dengan izin owner): pantau log 10 menit —
   grep "Memory usage" (rss stabil ±200-250MB, userbotAccounts= jumlah akun CONNECTED),
   grep "userbot-connected" muncul per akun, health /api/health = {"ok":true,"bot":"ready"}.

## ATURAN MAIN (dari owner, non-negotiable)

- Tanpa dependency baru. Semua pakai node stdlib + dep existing (fastify, grammy,
  teleproto, tsx).
- Gaya kode: one-liner padat di banyak fungsi util — ikuti gaya file yang ada,
  jangan direfactor ulang gaya penulisan.
- Komentar & pesan log dalam Bahasa Indonesia, nada teknis bukan copywriting.
- Jangan sentuh data Supabase secara tulis (±36 buyer ASLI); baca bebas.
- Jangan ubah semantik matching keyword (matchTerm) — bukan wilayah tugas ini.
- Jangan tambah copywriting baru di UI mini app.
- .env berisi kredensial produksi — JANGAN dicetak/di-commit. Untuk dev lokal lihat
  skill safe-local-run (nolkan env produksi dulu).

## REFERENSI

- Skill runbook produksi: ~/.hermes/skills/software-development/jaseb-production-ops/
  (berisi tabel reason "Incoming post ignored", playbook triage, catatan insiden OOM)
- Referensi pola yang diadopsi: /Users/user/Desktop/NEXO PROMOSI MINI APP/apps/engine/src/index.ts
  (syncRunners, lease, backoff DUPLICATED, self-scheduling sync)
