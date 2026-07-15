-- =====================================================================
-- 0008 — Case management : complaint_cases, case_assignments,
--        case_activity_logs (append-only), follow_up_tasks
-- =====================================================================

-- ---------------------------------------------------------------------
-- complaint_cases — เคสร้องเรียน/รักษา/ขอเปลี่ยนผู้ดูแล/positive
-- ---------------------------------------------------------------------
create table public.complaint_cases (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  case_no               text not null,
  response_id           uuid references public.survey_responses(id) on delete set null,
  customer_id           uuid references public.customers(id) on delete set null,
  type                  text not null check (type in ('complaint','retention','reassign_request','positive')),
  level                 text not null check (level in ('critical','high','medium','positive')),
  status                text not null default 'new'
                        check (status in ('new','ack','investigating','waiting_customer','in_progress','resolved','closed','reopened')),
  sla_due_at            timestamptz,
  resolution            text,
  closed_at             timestamptz,
  post_resolution_csat  numeric(4,2),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  unique (tenant_id, case_no)
);
create index idx_cases_tenant on public.complaint_cases(tenant_id);
create index idx_cases_customer on public.complaint_cases(customer_id);
create index idx_cases_status on public.complaint_cases(status);
create index idx_cases_level on public.complaint_cases(level);
create trigger trg_cases_updated before update on public.complaint_cases
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- case_assignments — เจ้าของเคส
-- ---------------------------------------------------------------------
create table public.case_assignments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  case_id            uuid not null references public.complaint_cases(id) on delete cascade,
  owner_employee_id  uuid references public.employees(id) on delete set null,
  assigned_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index idx_case_assign_tenant on public.case_assignments(tenant_id);
create index idx_case_assign_case on public.case_assignments(case_id);
create trigger trg_case_assign_updated before update on public.case_assignments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- case_activity_logs — timeline (append-only)
-- ---------------------------------------------------------------------
create table public.case_activity_logs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  case_id        uuid not null references public.complaint_cases(id) on delete cascade,
  actor_user_id  uuid references public.users(id) on delete set null,
  action         text not null,
  note           text,
  created_at     timestamptz not null default now()
);
create index idx_case_log_tenant on public.case_activity_logs(tenant_id);
create index idx_case_log_case on public.case_activity_logs(case_id);
create trigger trg_case_log_immutable before update or delete on public.case_activity_logs
  for each row execute function public.prevent_update_delete();

-- ---------------------------------------------------------------------
-- follow_up_tasks — งานติดตาม (Medium => Task)
-- ---------------------------------------------------------------------
create table public.follow_up_tasks (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  case_id              uuid references public.complaint_cases(id) on delete cascade,
  assignee_employee_id uuid references public.employees(id) on delete set null,
  due_at               timestamptz,
  status               text not null default 'open' check (status in ('open','in_progress','done','cancelled')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create index idx_followup_tenant on public.follow_up_tasks(tenant_id);
create index idx_followup_case on public.follow_up_tasks(case_id);
create trigger trg_followup_updated before update on public.follow_up_tasks
  for each row execute function public.set_updated_at();
