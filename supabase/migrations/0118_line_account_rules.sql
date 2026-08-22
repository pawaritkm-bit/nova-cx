-- 0118 — Learning map ผังบัญชี (Feature B)
--   จำว่า "คู่ค้ารายนี้ / คำอธิบายนี้ → นักบัญชีลงบัญชีรหัสไหน" แล้วเดาให้อัตโนมัติรอบถัดไป
--   ★ scope ระดับ tenant (ผังบัญชีใช้ร่วมทั้งสำนักงาน) · แยกตาม entry_type (ซื้อ/ขาย)
--   ★ เก็บ hit_count ต่อ (คู่ค้า → รหัสบัญชี) → เดา "รหัสที่ใช้บ่อยสุด" (รองรับคู่ค้าที่ลงได้หลายบัญชี)
create table if not exists public.line_account_rules (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  entry_type   text not null check (entry_type in ('purchase','sale')),
  -- match_type: 'tax' = เลขภาษีคู่ค้า (แม่นสุด) · 'name' = ชื่อคู่ค้า normalize
  match_type   text not null check (match_type in ('tax','name')),
  match_key    text not null,
  account_code text not null,
  account_name text,
  hit_count    integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, entry_type, match_type, match_key, account_code)
);

create index if not exists idx_line_account_rules_lookup
  on public.line_account_rules (tenant_id, entry_type, match_type, match_key, hit_count desc);

comment on table public.line_account_rules is
  'Learning map: คู่ค้า/คำอธิบาย → รหัสบัญชีที่นักบัญชีเคยเลือก (เดา account_code อัตโนมัติให้บิลใหม่)';

-- RLS: service-role เท่านั้น (ไม่มี policy = deny ทุก client key) — worker/action ใช้ service client
alter table public.line_account_rules enable row level security;
