-- =====================================================================
-- 0002 — Identity / Tenant : tenants, branches, roles, permissions,
--        role_permissions, users
-- =====================================================================

-- ---------------------------------------------------------------------
-- tenants — ราก multi-tenant
-- ---------------------------------------------------------------------
create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      text not null default 'active' check (status in ('active', 'suspended', 'inactive')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create trigger trg_tenants_updated before update on public.tenants
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- branches — สาขาของ tenant
-- ---------------------------------------------------------------------
create table public.branches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  code        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (tenant_id, code)
);
create index idx_branches_tenant on public.branches(tenant_id);
create trigger trg_branches_updated before update on public.branches
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- roles — 7 บทบาทพนักงาน (code คงที่)
-- ---------------------------------------------------------------------
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  code        text not null check (code in
    ('executive','acc_lead','accountant','sales_lead','sales','cs','admin')),
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (tenant_id, code)
);
create index idx_roles_tenant on public.roles(tenant_id);
create trigger trg_roles_updated before update on public.roles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- permissions — แคตตาล็อกสิทธิ์ (resource + action)
-- ---------------------------------------------------------------------
create table public.permissions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  code        text not null,          -- เช่น 'feedback.read'
  resource    text not null,          -- survey|feedback|customer_identity|case|dashboard|report|admin
  action      text not null,          -- read|create|update|delete|manage
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (tenant_id, code)
);
create index idx_permissions_tenant on public.permissions(tenant_id);
create trigger trg_permissions_updated before update on public.permissions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- role_permissions — จับคู่ role กับ permission พร้อม scope
-- scope: none|own|team|all (ตาม Permission Matrix §15)
-- ---------------------------------------------------------------------
create table public.role_permissions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  role_id       uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  scope         text not null default 'none' check (scope in ('none','own','team','all')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (role_id, permission_id)
);
create index idx_role_permissions_tenant on public.role_permissions(tenant_id);
create index idx_role_permissions_role on public.role_permissions(role_id);
create trigger trg_role_permissions_updated before update on public.role_permissions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- users — พนักงาน (Supabase Auth). ลูกค้าไม่อยู่ที่นี่ (ใช้ line_users)
-- auth_user_id ผูกกับ auth.users(id); employee_id ผูกภายหลัง (0003)
-- ---------------------------------------------------------------------
create table public.users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  auth_user_id  uuid unique,                      -- = auth.users.id (Supabase Auth)
  employee_id   uuid,                             -- FK เพิ่มใน 0003 (หลังสร้าง employees)
  role_id       uuid not null references public.roles(id),
  email         citext not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (tenant_id, email)
);
create index idx_users_tenant on public.users(tenant_id);
create index idx_users_auth on public.users(auth_user_id);
create index idx_users_role on public.users(role_id);
create trigger trg_users_updated before update on public.users
  for each row execute function public.set_updated_at();
