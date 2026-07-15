-- =====================================================================
-- 0005 — Assignment (effective-dated) + Sales
--        customer_assignments, sales_leads, sales_opportunities,
--        sales_status_history
-- =====================================================================

-- ---------------------------------------------------------------------
-- customer_assignments ★ effective-dated (temporal binding, NFR-09)
-- ผูกผู้ดูแลลูกค้า ณ ช่วงเวลา — ห้าม overwrite ให้เก็บ history
-- valid_to NULL = ปัจจุบัน
-- ---------------------------------------------------------------------
create table public.customer_assignments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  team_id       uuid references public.teams(id) on delete set null,
  role          text not null default 'member' check (role in ('lead','member','coordinator')),
  valid_from    date not null default current_date,
  valid_to      date,                              -- null = ผู้ดูแลปัจจุบัน
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  check (valid_to is null or valid_to >= valid_from)
);
create index idx_cust_assign_tenant on public.customer_assignments(tenant_id);
create index idx_cust_assign_customer on public.customer_assignments(customer_id);
create index idx_cust_assign_employee on public.customer_assignments(employee_id);
create index idx_cust_assign_team on public.customer_assignments(team_id);
-- ช่วยค้นหา "ผู้ดูแลปัจจุบัน" เร็ว
create index idx_cust_assign_current on public.customer_assignments(customer_id)
  where valid_to is null and deleted_at is null;
create trigger trg_cust_assign_updated before update on public.customer_assignments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- sales_leads
-- ---------------------------------------------------------------------
create table public.sales_leads (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  source      text,
  status      text not null default 'new' check (status in ('new','qualified','converted','disqualified')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index idx_sales_leads_tenant on public.sales_leads(tenant_id);
create trigger trg_sales_leads_updated before update on public.sales_leads
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- sales_opportunities — ดีลขาย (won/lost/open) => trigger survey C/D
-- ---------------------------------------------------------------------
create table public.sales_opportunities (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  customer_id         uuid references public.customers(id) on delete set null,
  lead_id             uuid references public.sales_leads(id) on delete set null,
  sales_employee_id   uuid references public.employees(id) on delete set null,
  stage               text,
  amount              numeric(14,2),
  status              text not null default 'open' check (status in ('open','won','lost')),
  closed_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create index idx_sales_opp_tenant on public.sales_opportunities(tenant_id);
create index idx_sales_opp_customer on public.sales_opportunities(customer_id);
create index idx_sales_opp_employee on public.sales_opportunities(sales_employee_id);
create trigger trg_sales_opp_updated before update on public.sales_opportunities
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- sales_status_history — ประวัติเปลี่ยนสถานะดีล (won->cancelled ฯลฯ)
-- ---------------------------------------------------------------------
create table public.sales_status_history (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  opportunity_id  uuid not null references public.sales_opportunities(id) on delete cascade,
  from_status     text,
  to_status       text not null,
  changed_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index idx_sales_hist_tenant on public.sales_status_history(tenant_id);
create index idx_sales_hist_opp on public.sales_status_history(opportunity_id);
create trigger trg_sales_hist_updated before update on public.sales_status_history
  for each row execute function public.set_updated_at();
