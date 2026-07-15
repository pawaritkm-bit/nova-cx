-- =====================================================================
-- 0009 — Ops : job_queue, notification_logs, cron_health
-- =====================================================================

-- ---------------------------------------------------------------------
-- job_queue — คิวงานเบื้องหลัง (notification | ai_analysis)
-- retry + backoff + dead_letter
-- ---------------------------------------------------------------------
create table public.job_queue (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  queue         text not null check (queue in ('notification','ai_analysis','line_event')),
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                check (status in ('pending','processing','sent','failed','dead')),
  attempts      integer not null default 0,
  max_attempts  integer not null default 5,
  run_at        timestamptz not null default now(),
  locked_at     timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index idx_job_queue_tenant on public.job_queue(tenant_id);
-- ช่วย worker ดึงงานที่พร้อมรัน
create index idx_job_queue_pull on public.job_queue(status, run_at);
create trigger trg_job_queue_updated before update on public.job_queue
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- notification_logs — บันทึกการส่งทุกครั้ง + retry
-- ---------------------------------------------------------------------
create table public.notification_logs (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  target               text not null check (target in ('customer','employee')),
  channel              text not null check (channel in ('line','email','dashboard')),
  ref_type             text check (ref_type in ('invitation','case','task')),
  ref_id               uuid,
  status               text not null default 'sent' check (status in ('sent','failed')),
  provider_message_id  text,
  error                text,
  sent_at              timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create index idx_notif_logs_tenant on public.notification_logs(tenant_id);
create index idx_notif_logs_ref on public.notification_logs(ref_type, ref_id);
create trigger trg_notif_logs_updated before update on public.notification_logs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- cron_health — health-check ราย job (บทเรียน: cron เงียบ)
-- ไม่ผูก tenant (ระดับระบบ)
-- ---------------------------------------------------------------------
create table public.cron_health (
  id            uuid primary key default gen_random_uuid(),
  job_name      text not null unique,
  last_run_at   timestamptz,
  status        text not null default 'unknown' check (status in ('ok','failed','unknown')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_cron_health_updated before update on public.cron_health
  for each row execute function public.set_updated_at();
