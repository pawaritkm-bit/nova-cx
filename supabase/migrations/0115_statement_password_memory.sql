-- =====================================================================
-- 0115 — จำรหัสสเตทเมนต์ที่ปลดสำเร็จ ไว้ใช้ครั้งต่อไป (ผูกกับ "ชื่อบัญชี")
--
--   ความต้องการ: เมื่อรหัส (นักบัญชีพิมพ์ในโน้ต / ลูกค้าส่งในแชท) ปลดสเตทเมนต์สำเร็จ
--   → จำรหัสนั้นไว้ ครั้งหน้าลองให้อัตโนมัติ  ★ ต้องผูกกับ "ชื่อบัญชีในสเตทเมนต์"
--   (account_name) เพื่อไม่ให้เอารหัสของบัญชีหนึ่งไปใช้ผิดบัญชี
--
--   scope: (tenant_id, chat_group_id, account_name_norm) — จำแยกตามกลุ่ม/ลูกค้า + ชื่อบัญชี
--   security: รหัสเก็บ "เข้ารหัส" (CREDENTIAL_ENC_KEY) ใน password_enc · เปิด RLS ไม่มี policy
--             → เข้าถึงได้เฉพาะ service role (bypass RLS) เท่านั้น (เป็นความลับ ห้าม anon)
--   idempotent: create table/index if not exists
-- =====================================================================
create table if not exists public.statement_password_memory (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  chat_group_id uuid not null,
  account_name_norm text not null,
  bank text,
  password_enc text not null,
  use_count int not null default 1,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (tenant_id, chat_group_id, account_name_norm)
);

create index if not exists idx_stmt_pw_group
  on public.statement_password_memory (tenant_id, chat_group_id);

alter table public.statement_password_memory enable row level security;
-- ไม่มี policy = anon/authenticated เข้าไม่ได้เลย · service role bypass RLS (worker/cron ใช้ได้)

comment on table public.statement_password_memory is
  'รหัส PDF สเตทเมนต์ที่ปลดสำเร็จ (เข้ารหัส) จำไว้ลองครั้งต่อไป ผูกกับชื่อบัญชี · service-role only';
