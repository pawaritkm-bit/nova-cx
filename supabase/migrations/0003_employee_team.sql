-- =====================================================================
-- 0003 — Employee / Team : employees, teams, team_members
--        + ผูก FK users.employee_id (หลังมี employees แล้ว)
-- =====================================================================

-- ---------------------------------------------------------------------
-- employees — พนักงาน (นักบัญชี/เซลล์) ที่ถูกประเมิน
-- ---------------------------------------------------------------------
create table public.employees (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  first_name     text not null,
  nickname       text,
  position       text,
  photo_url      text,
  employee_type  text not null check (employee_type in ('accountant','sales','cs','other')),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index idx_employees_tenant on public.employees(tenant_id);
create trigger trg_employees_updated before update on public.employees
  for each row execute function public.set_updated_at();

-- ผูก FK users.employee_id -> employees (ค้างไว้จาก 0002)
alter table public.users
  add constraint fk_users_employee
  foreign key (employee_id) references public.employees(id) on delete set null;

-- ---------------------------------------------------------------------
-- teams — ทีมบัญชี/ทีมขาย
-- ---------------------------------------------------------------------
create table public.teams (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  name              text not null,
  type              text not null check (type in ('accounting','sales','cs')),
  lead_employee_id  uuid references public.employees(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index idx_teams_tenant on public.teams(tenant_id);
create trigger trg_teams_updated before update on public.teams
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- team_members — สมาชิกทีม (effective-dated ผ่าน valid_from/valid_to)
-- ---------------------------------------------------------------------
create table public.team_members (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  team_id       uuid not null references public.teams(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  role_in_team  text not null default 'member' check (role_in_team in ('lead','member','coordinator')),
  valid_from    date not null default current_date,
  valid_to      date,                              -- null = ยังอยู่ในทีม
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  check (valid_to is null or valid_to >= valid_from)
);
create index idx_team_members_tenant on public.team_members(tenant_id);
create index idx_team_members_team on public.team_members(team_id);
create index idx_team_members_employee on public.team_members(employee_id);
create trigger trg_team_members_updated before update on public.team_members
  for each row execute function public.set_updated_at();
