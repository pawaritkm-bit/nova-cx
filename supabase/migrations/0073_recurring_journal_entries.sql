-- =====================================================================
-- 0073 — เฟส 6 ส่วน R (docs/06-accounting-features-roadmap.md, หมวด 0.2–0.8)
--   รายการบันทึกซ้ำ (Recurring Journal Entry) — ตั้ง manual JE (JV/PV/RV) ให้สร้างซ้ำอัตโนมัติ
--   ทุกเดือน/ไตรมาส/ปี (เช่น ค่าเช่า, ค่าบริการรายเดือน) — ต่อยอด manual_journal_entries เดิม
--   (เฟส 1 ส่วน C, migration 0066) 100% ไม่แตะ engine เดิมเลย
--
--   ★ occurrence ที่ cron/ปุ่ม "สร้างตอนนี้" สร้างให้ เป็น status='draft' เสมอ (0.3) — ไม่มีทาง
--     auto-confirm เข้าบัญชีจริงโดยไม่มีคนกดยืนยัน (แอปพลิเคชันเลเยอร์บังคับ ไม่ใช่ DB constraint)
--   ★ กับดัก date arithmetic ของ Postgres (0.5): `date + interval '1 month'` ไม่ clamp วันสิ้นเดือน
--     (31 ม.ค. + 1 เดือน → 2026-03-03 ไม่ใช่ 28/29 ก.พ.) — แก้ด้วย add_months_clamped() ที่ clamp
--     วันที่ให้ไม่เกินวันสุดท้ายของเดือนปลายทางเสมอ
--   ★ claim_recurring_je_occurrence() เป็น atomic RPC (for update skip locked, pattern เดียวกับ
--     0026_scheduled_invitation_rpc.sql) กัน cron/ปุ่มมือชนกันสร้างซ้ำ — SECURITY DEFINER, service_role เท่านั้น
--   ★ recurring_template_id บน manual_journal_entries เป็น metadata ล้วน (nullable, on delete set null)
--     ไม่ถูกใช้ในการคำนวณบัญชีใด ๆ (0.7) — ไม่กระทบ mapper toJournalLines/toJournalPosting เดิม
--
-- non-destructive: สร้างตารางใหม่ (create if not exists) + ALTER เพิ่มคอลัมน์ nullable บน
--   manual_journal_entries เท่านั้น ไม่แตะตาราง/flow เดิม
-- =====================================================================

create table if not exists public.recurring_journal_templates (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  customer_id        uuid not null references public.customers(id) on delete cascade,
  doc_type           text not null check (doc_type in ('JV','PV','RV')),
  memo               text,
  frequency          text not null check (frequency in ('monthly','quarterly','yearly')),
  start_date         date not null,
  next_run_date      date not null,
  end_date           date,
  is_active          boolean not null default true,
  last_generated_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index if not exists idx_recurring_je_templates_due
  on public.recurring_journal_templates (tenant_id, next_run_date)
  where deleted_at is null and is_active = true;
create index if not exists idx_recurring_je_templates_customer
  on public.recurring_journal_templates (tenant_id, customer_id) where deleted_at is null;

create table if not exists public.recurring_journal_template_lines (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references public.recurring_journal_templates(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  line_no       int not null default 1,
  account_code  text not null,
  account_name  text,
  description   text,
  debit         numeric(14,2) not null default 0,
  credit        numeric(14,2) not null default 0
);
create index if not exists idx_recurring_je_template_lines_template
  on public.recurring_journal_template_lines (tenant_id, template_id);

create table if not exists public.recurring_journal_generation_log (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  template_id      uuid not null references public.recurring_journal_templates(id) on delete cascade,
  run_date         date not null,
  status           text not null check (status in ('generated','failed')),
  message          text,
  manual_entry_id  uuid references public.manual_journal_entries(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists idx_recurring_je_gen_log_template
  on public.recurring_journal_generation_log (tenant_id, template_id, run_date);

-- ★ link occurrence → เทมเพลตต้นทาง (metadata ล้วน — ไม่กระทบ mapper ใด ๆ, ดู 0.7)
alter table public.manual_journal_entries
  add column if not exists recurring_template_id uuid
    references public.recurring_journal_templates(id) on delete set null;

drop trigger if exists trg_recurring_je_templates_updated on public.recurring_journal_templates;
create trigger trg_recurring_je_templates_updated before update on public.recurring_journal_templates
  for each row execute function public.set_updated_at();

-- ★ 0.5: บวกเดือนแบบ "clamp วันสิ้นเดือน" (ต่างจาก `date + interval` ดิบที่ overflow ข้ามเดือน)
create or replace function public.add_months_clamped(d date, n int)
returns date
language plpgsql
immutable
as $$
declare
  target_first date;
  last_day_of_target int;
  target_day int;
begin
  target_first := (date_trunc('month', d) + (n || ' months')::interval)::date;
  last_day_of_target := extract(day from (target_first + interval '1 month - 1 day'))::int;
  target_day := least(extract(day from d)::int, last_day_of_target);
  return (target_first + (target_day - 1) * interval '1 day')::date;
end;
$$;

-- ★ 0.4: claim แบบ atomic (for update skip locked) — กัน cron/ปุ่มมือชนกันสร้างซ้ำ
create or replace function public.claim_recurring_je_occurrence(
  p_tenant_id   uuid,
  p_template_id uuid,
  p_today       date
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.recurring_journal_templates%rowtype;
  v_months int;
  v_new_next date;
begin
  select * into v_row
  from public.recurring_journal_templates
  where id = p_template_id and tenant_id = p_tenant_id
    and deleted_at is null and is_active = true
    and next_run_date <= p_today
    and (end_date is null or next_run_date <= end_date)
  for update skip locked;

  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  v_months := case v_row.frequency
    when 'monthly' then 1
    when 'quarterly' then 3
    else 12
  end;
  v_new_next := public.add_months_clamped(v_row.next_run_date, v_months);

  update public.recurring_journal_templates
     set next_run_date = v_new_next, last_generated_at = now()
   where id = p_template_id and tenant_id = p_tenant_id;

  return jsonb_build_object(
    'claimed', true,
    'run_date', v_row.next_run_date,
    'doc_type', v_row.doc_type,
    'memo', v_row.memo,
    'customer_id', v_row.customer_id
  );
end;
$$;

revoke all on function public.claim_recurring_je_occurrence(uuid, uuid, date) from public;
grant execute on function public.claim_recurring_je_occurrence(uuid, uuid, date) to service_role;

alter table public.recurring_journal_templates       enable row level security;
alter table public.recurring_journal_template_lines  enable row level security;
alter table public.recurring_journal_generation_log  enable row level security;
drop policy if exists tenant_read on public.recurring_journal_templates;
create policy tenant_read on public.recurring_journal_templates for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.recurring_journal_template_lines;
create policy tenant_read on public.recurring_journal_template_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.recurring_journal_generation_log;
create policy tenant_read on public.recurring_journal_generation_log for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.recurring_journal_templates       from anon;
revoke all on public.recurring_journal_template_lines  from anon;
revoke all on public.recurring_journal_generation_log  from anon;
grant select on public.recurring_journal_templates       to authenticated;
grant select on public.recurring_journal_template_lines  to authenticated;
grant select on public.recurring_journal_generation_log  to authenticated;
grant all    on public.recurring_journal_templates       to service_role;
grant all    on public.recurring_journal_template_lines  to service_role;
grant all    on public.recurring_journal_generation_log  to service_role;

notify pgrst, 'reload schema';
