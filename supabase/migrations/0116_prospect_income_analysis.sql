-- =====================================================================
-- 0116 — วิเคราะห์รายรับว่าที่ลูกค้า (sales pitch)
--
--   สะสม "ยอดเงินเข้าต่อธนาคาร ต่อปี" ของว่าที่ลูกค้า (ผูก chat_group) จากสเตทเมนต์
--   ที่ deterministic parse ผ่าน → ใช้รวมหลายธนาคารเป็นตารางวิเคราะห์ (Excel) ให้ฝ่ายขาย
--
--   scope: (tenant_id, chat_group_id, bank_label, year) — จำแยกตามกลุ่ม/ลูกค้า + ธนาคาร + ปี
--   security: เปิด RLS ไม่มี policy → เข้าถึงได้เฉพาะ service role (bypass RLS) เท่านั้น
--             (ข้อมูลการเงินว่าที่ลูกค้า — ห้าม anon)
--   idempotent: create table/index if not exists
-- =====================================================================
create table if not exists public.prospect_bank_summaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  chat_group_id uuid not null,
  bank_label text not null,
  year int not null,
  -- [{ "month": 1..12, "totalIn": number, "count": number }]
  monthly jsonb not null default '[]'::jsonb,
  closing_balance numeric,
  updated_at timestamptz not null default now()
);

create unique index if not exists prospect_bank_summaries_key
  on public.prospect_bank_summaries (tenant_id, chat_group_id, bank_label, year);

alter table public.prospect_bank_summaries enable row level security;
-- ไม่มี policy → service role เท่านั้น
