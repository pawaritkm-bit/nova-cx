-- =====================================================================
-- 0010 — PDPA / Audit : consent_records, do_not_contact_records,
--        audit_logs (append-only immutable)
-- =====================================================================

-- ---------------------------------------------------------------------
-- consent_records — ความยินยอม PDPA ก่อนเริ่ม (FR-PD-01/02)
-- ---------------------------------------------------------------------
create table public.consent_records (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  customer_id    uuid not null references public.customers(id) on delete cascade,
  policy_version text not null,
  purpose_json   jsonb not null default '{}'::jsonb,   -- วัตถุประสงค์/ข้อมูล/ผู้เข้าถึง/ระยะเวลา
  consented_at   timestamptz,
  withdrawn_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index idx_consent_tenant on public.consent_records(tenant_id);
create index idx_consent_customer on public.consent_records(customer_id);
create trigger trg_consent_updated before update on public.consent_records
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- do_not_contact_records ★ — หยุด sales automation ทันที (C-13, FR-NT-06)
-- ---------------------------------------------------------------------
create table public.do_not_contact_records (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  customer_id    uuid not null references public.customers(id) on delete cascade,
  source         text not null check (source in ('form_D','request','admin')),
  effective_at   timestamptz not null default now(),
  reason         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index idx_dnc_tenant on public.do_not_contact_records(tenant_id);
create index idx_dnc_customer on public.do_not_contact_records(customer_id);
create trigger trg_dnc_updated before update on public.do_not_contact_records
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- audit_logs ★ — append-only immutable (FR-AG-02, C-07/C-10)
-- ทุก action สำคัญ (แก้คะแนน / Admin เปิดตัวตน / ส่งแบบประเมิน)
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  actor_user_id  uuid references public.users(id) on delete set null,
  action         text not null,
  resource       text not null,
  resource_id    uuid,
  meta           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index idx_audit_tenant on public.audit_logs(tenant_id);
create index idx_audit_resource on public.audit_logs(resource, resource_id);
create index idx_audit_actor on public.audit_logs(actor_user_id);
-- immutable: ห้ามแก้/ลบ แม้ service_role
create trigger trg_audit_immutable before update or delete on public.audit_logs
  for each row execute function public.prevent_update_delete();
