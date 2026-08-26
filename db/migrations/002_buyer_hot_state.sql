-- Jalankan sekali lewat `npm run db:migrate` atau Supabase SQL Editor.
-- Memecah data PANAS (aktivitas per buyer + state antrean kirim) keluar dari
-- blob app_state supaya jalur tersibuk (setiap pengiriman broadcast) menulis
-- baris kecil per buyer, bukan menulis-ulang SELURUH state semua user.

create table if not exists public.app_buyer_state (
  buyer_id text not null,
  slot text not null check (slot in ('ACTIVITIES', 'RUNTIME:ADMIN', 'RUNTIME:BUYER')),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (buyer_id, slot)
);

alter table public.app_buyer_state enable row level security;
revoke all on table public.app_buyer_state from anon, authenticated;
