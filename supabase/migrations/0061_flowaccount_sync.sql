-- =====================================================================
-- 0061 — ส่งไป FlowAccount (M1: บิลขาย confirmed → sync manual-trigger)
-- =====================================================================
-- บริบท (docs/05-flowaccount-integration.md):
--   ปุ่ม "ส่งไป FlowAccount" ต่อบิลขาย (entry_type='sale') ที่ยืนยันแล้ว (status='confirmed')
--   กดทีละใบ ไม่มี background job ไม่มี auto-retry เงียบ — ต้องมี:
--     1) คอลัมน์ sync status บน bill_entries (กันกดซ้ำด้วย atomic claim ระดับ Postgres row)
--     2) ตาราง log ทุกครั้งที่กดส่ง (สำเร็จ/ล้ม) เพื่อตรวจสอบย้อนหลังได้
--
--   flowaccount_sync_status ค่า:
--     not_synced → syncing (claim) → synced (สำเร็จ) | failed (ล้ม → กดส่งใหม่ได้)
--   flowaccount_needs_resync: true = ส่งไปแล้วแต่บิลถูกแก้ทีหลัง (เตือน "ควรส่งใหม่" — ไม่ auto-resync)
--
-- non-destructive: เพิ่มคอลัมน์ (nullable/default) ให้ bill_entries + สร้างตารางใหม่ 1 ตัว
--   ไม่แตะ query/flow เดิม (ตาม pattern 0046/0053/0054/0060)
-- =====================================================================

alter table public.bill_entries
  add column if not exists flowaccount_sync_status text not null default 'not_synced'
    check (flowaccount_sync_status in ('not_synced','syncing','synced','failed')),
  add column if not exists flowaccount_doc_type text
    check (flowaccount_doc_type in ('tax_invoice','cash_sale') or flowaccount_doc_type is null),
  add column if not exists flowaccount_doc_id text,
  add column if not exists flowaccount_doc_no text,
  add column if not exists flowaccount_synced_at timestamptz,
  add column if not exists flowaccount_last_error text,
  add column if not exists flowaccount_last_attempted_at timestamptz,
  add column if not exists flowaccount_needs_resync boolean not null default false;

comment on column public.bill_entries.flowaccount_sync_status is
  'สถานะส่งไป FlowAccount: not_synced/syncing/synced/failed — syncing ตั้งด้วย atomic claim กันกดซ้ำ';
comment on column public.bill_entries.flowaccount_last_error is
  'ข้อความ error สั้น ๆ ครั้งล่าสุด (ไม่มี payload/PII) — โชว์ให้นักบัญชีเห็นก่อนกดส่งใหม่';
comment on column public.bill_entries.flowaccount_needs_resync is
  'true = ส่งไปแล้วแต่บิลถูกแก้ทีหลัง (นักบัญชีควรกดส่งใหม่ — ไม่ auto-resync)';

-- index ช่วย query สถานะ sync ต่อ tenant (เช่นหน้ารายงาน sync ในอนาคต)
create index if not exists idx_bill_entries_flowaccount_status
  on public.bill_entries (tenant_id, flowaccount_sync_status)
  where deleted_at is null;

-- ---------------------------------------------------------------------
-- flowaccount_sync_log — audit ทุกครั้งที่กดส่ง (สำเร็จ/ล้ม)
--   requested_by : employees.id ของ staff (นักบัญชี/หัวหน้า) — null = admin/executive (Supabase Auth)
-- ---------------------------------------------------------------------
create table if not exists public.flowaccount_sync_log (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  entry_id            uuid not null references public.bill_entries(id) on delete cascade,
  doc_type            text check (doc_type in ('tax_invoice','cash_sale') or doc_type is null),
  status              text not null check (status in ('success','failed')),
  flowaccount_doc_id  text,
  error_message       text,
  requested_by        text,
  created_at          timestamptz not null default now()
);

create index if not exists idx_flowaccount_sync_log_tenant_entry
  on public.flowaccount_sync_log (tenant_id, entry_id);
create index if not exists idx_flowaccount_sync_log_entry_created
  on public.flowaccount_sync_log (entry_id, created_at desc);

-- =====================================================================
-- RLS: tenant isolation (pattern 0046/0054)
--   authenticated : SELECT เท่านั้น — write ผ่าน service_role (server action guard admin/นักบัญชี)
--   service_role  : all
-- =====================================================================
alter table public.flowaccount_sync_log enable row level security;

create policy tenant_read on public.flowaccount_sync_log for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- GRANT posture (pattern 0046/0054)
revoke all on public.flowaccount_sync_log from anon;
grant select on public.flowaccount_sync_log to authenticated;
grant all    on public.flowaccount_sync_log to service_role;

-- reload PostgREST schema cache (คอลัมน์/ตารางใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
