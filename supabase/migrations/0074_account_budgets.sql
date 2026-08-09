-- เฟส 6 ส่วน S (docs/06, หมวด 0.9–0.12) — งบประมาณต่อรหัสบัญชี/เดือน/ปี

create table if not exists public.account_budgets (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  account_code  text not null,
  year          int not null check (year between 2000 and 2100),
  month         int not null check (month between 1 and 12),
  amount        numeric(14,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_account_budgets
  on public.account_budgets (tenant_id, customer_id, account_code, year, month);
create index if not exists idx_account_budgets_customer_year
  on public.account_budgets (tenant_id, customer_id, year);

drop trigger if exists trg_account_budgets_updated on public.account_budgets;
create trigger trg_account_budgets_updated before update on public.account_budgets
  for each row execute function public.set_updated_at();

alter table public.account_budgets enable row level security;
create policy tenant_read on public.account_budgets for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.account_budgets from anon;
grant select on public.account_budgets to authenticated;
grant all    on public.account_budgets to service_role;

notify pgrst, 'reload schema';
