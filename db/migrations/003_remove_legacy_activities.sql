-- Jalankan sekali lewat `npm run db:migrate` atau Supabase SQL Editor.
-- Riwayat aktivitas lama (key `activities` di blob app_state) sudah disalin
-- ke tabel app_buyer_state slot ACTIVITIES oleh server saat load. Key legacy
-- ini TIDAK dipakai lagi, tapi masih nyangkut di blob (984KB) dan ikut
-- ditulis-ulang tiap save(). Hapus dari blob supaya blob menyusut.
-- Idempoten: hanya menghapus bila key masih ada.

update public.app_state
set state = state - 'activities',
    updated_at = now()
where id = 'primary'
  and state ? 'activities';
