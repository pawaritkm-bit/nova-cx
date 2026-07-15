-- =====================================================================
-- 0019 — NOVA Sales Integration : external reference (idempotency)
--   เพิ่มคอลัมน์ external_ref เพื่อจับคู่ระเบียนฝั่ง NOVA Sales แบบ idempotent
--   (กันยิงซ้ำสร้างลูกค้า/ดีลซ้ำ) — service-role เขียน, ไม่กระทบ RLS/grants เดิม
-- =====================================================================

alter table public.customers
  add column if not exists external_ref text;
create unique index if not exists uq_customers_external_ref
  on public.customers(tenant_id, external_ref)
  where external_ref is not null and deleted_at is null;
comment on column public.customers.external_ref is
  'id ลูกค้าฝั่ง NOVA Sales (external_customer_id) ใช้ทำ idempotent upsert';

alter table public.sales_leads
  add column if not exists external_ref text;
create unique index if not exists uq_sales_leads_external_ref
  on public.sales_leads(tenant_id, external_ref)
  where external_ref is not null and deleted_at is null;
comment on column public.sales_leads.external_ref is
  'external_lead_id ฝั่ง NOVA Sales — idempotent upsert';

alter table public.sales_opportunities
  add column if not exists external_ref text;
create unique index if not exists uq_sales_opps_external_ref
  on public.sales_opportunities(tenant_id, external_ref)
  where external_ref is not null and deleted_at is null;
comment on column public.sales_opportunities.external_ref is
  'external_deal_id ฝั่ง NOVA Sales — idempotent upsert (1 ดีล/1 ระเบียน)';
