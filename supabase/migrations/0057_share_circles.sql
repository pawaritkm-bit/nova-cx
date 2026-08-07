-- =====================================================================
-- 0057 — วงแชร์ (share_circle_entries) : ลงบัญชี "รายได้วงแชร์" ของท้าวแชร์
-- =====================================================================
-- บริบท: ลูกค้าที่เป็น "ท้าวแชร์" (เช่น P718 พิมพ์ศิริ) ส่งลิสต์วงแชร์เข้ากลุ่มไลน์
--   (รูป + คำพิม). นักบัญชีต้องเอา "รายได้จากวงแชร์" ไปคิดภาษี:
--     • ภธ.40 (ภาษีธุรกิจเฉพาะ) รายเดือน — ฐาน=(ΣG+ΣI)×3.3% (SBT 3% + ท้องถิ่น 10%)
--     • ภงด.90 ปลายปี — รายได้รวมทั้งปี หักเหมา 60/40 (เหลือ 40%) แล้วคิดขั้นบันได
--
--   ★ ถอดจากไฟล์ Excel จริงของลูกค้า: ไฟล์เก็บระดับ "วง/เดือน" เท่านั้น
--     — ไม่มีรายชื่อสมาชิก/มือรายคน (มีแค่ "จำนวนสมาชิก" เป็นตัวเลข)
--   ★ 1 แถว = 1 วง/เดือน. คอลัมน์ตรงกับไฟล์: G=รายได้ท้าว, H=ค่าบริหารจัดการ,
--     I=ค่าดำเนินการ/วง (ส่วนมาก 0 "ฟรีค่าดูแล"), J=ดอกเบี้ยรับ, K=ค่าใช้จ่าย/ต้นทุน
--
--   ★ tenant-scoped + RLS (pattern 0054): authenticated อ่านอย่างเดียว,
--     write ผ่าน service_role (server action ที่ guard admin + customer scope).
--   ★ soft-delete (deleted_at) — ไม่ลบจริง.
--
-- non-destructive: สร้างตารางใหม่ (create if not exists) ไม่แตะตาราง/flow เดิม
-- =====================================================================

-- ---- วง/เดือน (1 แถว = 1 วง ของ 1 เดือน) ----
create table if not exists public.share_circle_entries (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id)   on delete cascade,
  customer_id        uuid not null references public.customers(id) on delete cascade,

  -- ช่วงเวลา: period_month เก็บ 'YYYY-MM' (ปี ค.ศ.) · entry_date = วันที่ในเอกสาร (ถ้ามี)
  period_month       text not null,
  entry_date         date,

  -- ข้อมูลวง (ตามไฟล์ Excel)
  circle_name        text not null,               -- ชื่อวง (เช่น "วงบิท วงคริสต์มาส")
  round_note         text,                         -- รอบเปีย: รายเดือน / ราย 10 วัน / ราย 15 วัน
  member_count       integer,                      -- จำนวนสมาชิก (เช่น 21)
  principal_per_head numeric(16,2),                -- เงินต้นแชร์/คน (เช่น 100000)

  -- คอลัมน์คิดภาษี (ตรงกับไฟล์ G/H/I/J/K)
  tao_income         numeric(16,2),                -- (G) รายได้ท้าว — เงินก้อนที่ท้าวเปียได้
  mgmt_fee           numeric(16,2),                -- (H) ค่าบริหารจัดการ ท้าวแชร์
  operation_fee      numeric(16,2),                -- (I) ค่าดำเนินการ/วง (ส่วนมาก 0)
  interest_income    numeric(16,2),                -- (J) ดอกเบี้ยรับ
  expense            numeric(16,2),                -- (K) ค่าใช้จ่าย/ต้นทุน

  -- ที่มา (AI อ่านจากไลน์ / คีย์เอง)
  source             text,                         -- 'ai' | 'manual'
  source_ref         text,                         -- อ้างอิงที่มา (เช่น 'line:YYYY-MM') — ไม่มี PII
  source_text        text,                         -- สรุปย่อของวง (★ ห้ามเก็บเนื้อแชตดิบ/PII)

  status             text not null default 'active',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

-- index หลัก: ไล่วงของลูกค้ารายเดือน (กรอง soft-delete)
create index if not exists idx_share_circle_entries_tenant_customer_month
  on public.share_circle_entries (tenant_id, customer_id, period_month)
  where deleted_at is null;

-- trigger set_updated_at (function มีอยู่แล้วในโปรเจกต์ — ดู 0032/0054 เดิม)
--   drop ก่อน create ให้ apply ซ้ำได้ (create trigger ไม่มี "if not exists" ใน Postgres)
drop trigger if exists trg_share_circle_entries_updated on public.share_circle_entries;
create trigger trg_share_circle_entries_updated before update on public.share_circle_entries
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS: tenant isolation (pattern 0054)
--   authenticated : SELECT เท่านั้น — write ผ่าน service_role (server action guard admin)
--   service_role  : all
-- =====================================================================
alter table public.share_circle_entries enable row level security;

drop policy if exists tenant_read on public.share_circle_entries;
create policy tenant_read on public.share_circle_entries for select to authenticated
  using (tenant_id = public.current_tenant_id());

revoke all    on public.share_circle_entries from anon;
grant  select on public.share_circle_entries to authenticated;
grant  all    on public.share_circle_entries to service_role;

-- =====================================================================
-- flag ที่ customers : "ลูกค้าเป็นท้าวแชร์" (สวิตช์เปิดครั้งเดียว)
--   เพื่อแก้ปัญหาไก่กับไข่ — ลูกค้าท้าวแชร์รายใหม่ที่ยัง 0 วง ต้องมีแท็บให้เริ่ม
--   (เปิดสวิตช์แล้วแท็บ "วงแชร์" โผล่ทันที กด "อ่านจากไลน์/เพิ่มวง" ได้)
--   ★ non-destructive: add column if not exists, default false → ไม่กระทบ flow เดิม
-- =====================================================================
alter table public.customers
  add column if not exists is_share_circle boolean not null default false;

-- reload PostgREST schema cache (ตาราง/คอลัมน์ใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
