-- =====================================================================
-- 0004 — Customer / LINE : customers, customer_contacts, line_users,
--        customer_services
-- =====================================================================

-- ---------------------------------------------------------------------
-- customers — ลูกค้า (นิติบุคคล/บุคคล)
-- ---------------------------------------------------------------------
create table public.customers (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  customer_code       text,
  name                text not null,
  business_name       text,
  service_start_date  date,
  status              text not null default 'active' check (status in ('active','cancelled','prospect')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (tenant_id, customer_code)
);
create index idx_customers_tenant on public.customers(tenant_id);
create trigger trg_customers_updated before update on public.customers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- customer_contacts — ผู้ติดต่อ (PII เข้ารหัสด้วย CREDENTIAL_ENC_KEY ระดับแอป)
-- คอลัมน์ _enc เก็บ ciphertext เท่านั้น ห้ามเก็บ plain text
-- ---------------------------------------------------------------------
create table public.customer_contacts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  name          text,
  phone_enc     text,                              -- ciphertext
  email_enc     text,                              -- ciphertext
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index idx_customer_contacts_tenant on public.customer_contacts(tenant_id);
create index idx_customer_contacts_customer on public.customer_contacts(customer_id);
create trigger trg_customer_contacts_updated before update on public.customer_contacts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- line_users — บัญชี LINE ของลูกค้า (auth domain แยกจากพนักงาน)
-- ห้ามเก็บ access token plain (C-14)
-- ---------------------------------------------------------------------
create table public.line_users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid references public.customers(id) on delete set null,
  line_user_id  text not null,                     -- LINE userId (U....)
  display_name  text,
  is_blocked    boolean not null default false,
  linked_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (tenant_id, line_user_id)
);
create index idx_line_users_tenant on public.line_users(tenant_id);
create index idx_line_users_customer on public.line_users(customer_id);
create trigger trg_line_users_updated before update on public.line_users
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- customer_services — บริการที่ลูกค้าใช้
-- ---------------------------------------------------------------------
create table public.customer_services (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  service_type  text not null,
  started_at    date,
  ended_at      date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index idx_customer_services_tenant on public.customer_services(tenant_id);
create index idx_customer_services_customer on public.customer_services(customer_id);
create trigger trg_customer_services_updated before update on public.customer_services
  for each row execute function public.set_updated_at();
