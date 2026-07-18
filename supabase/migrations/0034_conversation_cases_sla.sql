-- =====================================================================
-- 0034 — Conversation Cases + SLA (Phase 3) : เปลี่ยนผลวิเคราะห์แชตเป็น "เคส"
--   ต่อจาก 0033 (chat AI analysis : ai_chat_analysis / customer_sentiment / sop_violations)
--
-- โมดูล "AI วิเคราะห์แชท+ประเมินนักบัญชี" — Phase 3:
--   ผลวิเคราะห์ (Phase 2) พบ "คำขอ/งาน/ปัญหา" → เปิด/อัปเดต conversation_case
--   → resolve owner (นักบัญชีผู้ดูแล ณ เวลานั้น จาก customer_assignments)
--   → คำนวณ SLA due จาก sla_rules ที่ match (fallback default business-hours)
--   → ติดตาม SLA (breach scanner) → sla_events + risk_alerts + แจ้งเตือน/escalate
--
-- ★ decision (analyst): สร้าง conversation_cases แยกจาก complaint_cases (0008)
--   complaint_cases ผูก survey/RLS แล้ว — ยัดของแชตเสี่ยงพัง → แยกตารางใหม่ทั้งชุด
--
-- non-destructive:
--   - สร้างตารางใหม่ 6 ตัว (sla_rules / conversation_cases / case_messages /
--     case_status_history / sla_events / risk_alerts)
--   - ALTER job_queue CHECK เพิ่มค่า 'case_notification' (คงค่าเดิมครบ)
--   - เพิ่ม helper public.case_level_rank() + RPC open_or_update_conversation_case()
--   ไม่แตะ complaint_cases / survey / webhook / pseudonymity (0025/0027) / chat 0031-0033
-- =====================================================================

-- ---------------------------------------------------------------------
-- helper: จัดอันดับความรุนแรงของ level (ยิ่งน้อยยิ่งรุนแรง) — ใช้ bump level เคส
-- ---------------------------------------------------------------------
create or replace function public.case_level_rank(p_level text)
returns integer
language sql
immutable
as $$
  select case lower(coalesce(p_level, ''))
    when 'critical' then 0
    when 'high'     then 1
    when 'medium'   then 2
    else 3
  end
$$;

-- ---------------------------------------------------------------------
-- sla_rules ★ — config ตั้งค่า SLA ต่อ tenant (rule engine)
--   scope fields (customer_type/urgency/work_type/team_id) : nullable = match ทั้งหมด
--   working_hours : jsonb null = ใช้ default (จ–ศ 9:00–18:00 Asia/Bangkok)
--   priority      : rule ที่ priority สูงกว่าถูกเลือกก่อน (ตัวเลขมาก = มาก่อน)
--   *_minutes     : เวลาทำการที่ต้องตอบ/ปิด (นับเฉพาะเวลาทำการ)
-- ---------------------------------------------------------------------
create table if not exists public.sla_rules (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  name                   text not null,
  customer_type          text,          -- null = ทุกประเภทลูกค้า
  urgency                text,          -- null = ทุกระดับ (critical/high/medium/low)
  work_type              text,          -- null = ทุกประเภทงาน
  team_id                uuid references public.teams(id) on delete set null,  -- null = ทุกทีม
  working_hours          jsonb,         -- null = default จ–ศ 9–18 (คำนวณผ่าน lib/ai/case.ts)
  first_response_minutes integer,       -- นาทีทำการที่ต้อง "ตอบครั้งแรก"
  resolution_minutes     integer,       -- นาทีทำการที่ต้อง "ปิดงาน"
  priority               integer not null default 100,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);
create index if not exists idx_sla_rules_tenant on public.sla_rules(tenant_id);
create index if not exists idx_sla_rules_active on public.sla_rules(tenant_id, priority)
  where is_active and deleted_at is null;
create trigger trg_sla_rules_updated before update on public.sla_rules
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- conversation_cases ★ — เคสจากบทสนทนาแชต (แยกจาก complaint_cases โดยเจตนา)
--   owner_employee_id   : นักบัญชีผู้ดูแลลูกค้า ณ เวลาเปิดเคส (จาก customer_assignments)
--   status              : เทียบ complaint_cases (open/in_progress/waiting_customer/resolved/closed/reopened)
--   urgency             : ระดับความเร่งด่วนจาก AI (critical/high/medium/low)
--   level               : ระดับเคสสำหรับ SLA/escalation (critical/high/medium)
--   first_response_due_at / resolution_due_at : กำหนดจาก sla_rules ที่ match
--   first_responded_at  : เวลาที่มีการตอบครั้งแรกหลังเปิดเคส (ปิด SLA first-response)
-- ---------------------------------------------------------------------
create table if not exists public.conversation_cases (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  customer_id            uuid references public.customers(id) on delete set null,
  chat_group_id          uuid not null references public.chat_groups(id) on delete cascade,
  owner_employee_id      uuid references public.employees(id) on delete set null,
  title                  text,
  summary                text,
  status                 text not null default 'open'
                          check (status in ('open','in_progress','waiting_customer','resolved','closed','reopened')),
  urgency                text check (urgency in ('critical','high','medium','low')),
  level                  text not null default 'high'
                          check (level in ('critical','high','medium')),
  source                 text not null default 'chat' check (source in ('chat','survey','manual')),
  sla_rule_id            uuid references public.sla_rules(id) on delete set null,
  first_response_due_at  timestamptz,
  resolution_due_at      timestamptz,
  first_responded_at     timestamptz,
  opened_at              timestamptz not null default now(),
  closed_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);
create index if not exists idx_conv_cases_tenant on public.conversation_cases(tenant_id);
create index if not exists idx_conv_cases_group on public.conversation_cases(chat_group_id);
create index if not exists idx_conv_cases_customer on public.conversation_cases(customer_id);
create index if not exists idx_conv_cases_owner on public.conversation_cases(owner_employee_id);
create index if not exists idx_conv_cases_status on public.conversation_cases(status);
-- เร่ง scanner: หาเคสที่ยังเปิดอยู่ (breach scan)
create index if not exists idx_conv_cases_open
  on public.conversation_cases(tenant_id, resolution_due_at)
  where status in ('open','in_progress','waiting_customer','reopened') and deleted_at is null;
-- กันเปิดเคส active ซ้ำต่อกลุ่ม (idempotency ชั้น DB) — 1 กลุ่มมีเคส active ได้ 1 เคส
create unique index if not exists uq_conv_cases_active_group
  on public.conversation_cases(chat_group_id)
  where status in ('open','in_progress','waiting_customer','reopened') and deleted_at is null;
create trigger trg_conv_cases_updated before update on public.conversation_cases
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- case_messages — โยง chat_messages ↔ conversation_case (unique กันโยงซ้ำ)
-- ---------------------------------------------------------------------
create table if not exists public.case_messages (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  case_id          uuid not null references public.conversation_cases(id) on delete cascade,
  chat_message_id  uuid not null references public.chat_messages(id) on delete cascade,
  created_at       timestamptz not null default now(),
  unique (case_id, chat_message_id)
);
create index if not exists idx_case_messages_tenant on public.case_messages(tenant_id);
create index if not exists idx_case_messages_case on public.case_messages(case_id);
create index if not exists idx_case_messages_message on public.case_messages(chat_message_id);

-- ---------------------------------------------------------------------
-- case_status_history — timeline เปลี่ยนสถานะเคส (append-only เหมือน case_activity_logs)
--   changed_by : uuid ผู้ทำรายการ (user/employee/worker) — เก็บเป็น audit ไม่ FK แข็ง
-- ---------------------------------------------------------------------
create table if not exists public.case_status_history (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  case_id      uuid not null references public.conversation_cases(id) on delete cascade,
  from_status  text,
  to_status    text not null,
  changed_by   uuid,
  note         text,
  changed_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index if not exists idx_case_status_hist_tenant on public.case_status_history(tenant_id);
create index if not exists idx_case_status_hist_case on public.case_status_history(case_id);
create trigger trg_case_status_hist_immutable before update or delete on public.case_status_history
  for each row execute function public.prevent_update_delete();
create trigger trg_case_status_hist_no_truncate before truncate on public.case_status_history
  for each statement execute function public.prevent_update_delete();

-- ---------------------------------------------------------------------
-- sla_events — เหตุการณ์ SLA ของเคส (idempotent : unique case_id+event_type)
--   event_type : opened | response_due_soon | response_breached |
--                resolution_due_soon | resolution_breached
--   1 เคสเกิด event แต่ละชนิดได้ครั้งเดียว → scanner ยิงซ้ำได้ไม่ซ้ำผล
-- ---------------------------------------------------------------------
create table if not exists public.sla_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  case_id      uuid not null references public.conversation_cases(id) on delete cascade,
  event_type   text not null
                check (event_type in ('opened','response_due_soon','response_breached',
                                      'resolution_due_soon','resolution_breached')),
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (case_id, event_type)
);
create index if not exists idx_sla_events_tenant on public.sla_events(tenant_id);
create index if not exists idx_sla_events_case on public.sla_events(case_id);

-- ---------------------------------------------------------------------
-- risk_alerts — ระดับความเสี่ยงต่อเคส/ลูกค้า (เขียว/เหลือง/ส้ม/แดง)
--   level  : green(ปกติ)/yellow(ติดตาม)/orange(เสี่ยงร้องเรียน)/red(หัวหน้าด่วน)
--   status : open → acknowledged → resolved
--   escalated_at / escalated_to_employee_id : ยกระดับไปหัวหน้าทีมแล้ว (owner→lead)
--   case_id nullable : alert อาจผูกลูกค้าโดยไม่มีเคส (best-effort)
-- ---------------------------------------------------------------------
create table if not exists public.risk_alerts (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references public.tenants(id) on delete cascade,
  case_id                   uuid references public.conversation_cases(id) on delete cascade,
  customer_id               uuid references public.customers(id) on delete set null,
  level                     text not null default 'yellow' check (level in ('green','yellow','orange','red')),
  reason                    text,
  owner_employee_id         uuid references public.employees(id) on delete set null,
  status                    text not null default 'open' check (status in ('open','acknowledged','resolved')),
  escalated_at              timestamptz,
  escalated_to_employee_id  uuid references public.employees(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  deleted_at                timestamptz
);
create index if not exists idx_risk_alerts_tenant on public.risk_alerts(tenant_id);
create index if not exists idx_risk_alerts_case on public.risk_alerts(case_id);
create index if not exists idx_risk_alerts_customer on public.risk_alerts(customer_id);
create index if not exists idx_risk_alerts_status on public.risk_alerts(status);
-- 1 เคสมี alert ที่ยัง active (open/acknowledged) ได้ตัวเดียว → scanner upsert ไม่ซ้ำ
create unique index if not exists uq_risk_alerts_active_case
  on public.risk_alerts(case_id)
  where case_id is not null and status in ('open','acknowledged');
create trigger trg_risk_alerts_updated before update on public.risk_alerts
  for each row execute function public.set_updated_at();

-- =====================================================================
-- job_queue.queue CHECK : เพิ่ม 'case_notification' (คงค่าเดิมครบ)
--   ★ ใช้ queue แยกจาก 'notification' โดยเจตนา — survey notify worker กรอง
--     queue='notification' อยู่แล้ว จึงไม่หยิบงานแจ้งเตือนเคสไปทำ (ไม่แตะของเดิม)
-- =====================================================================
alter table public.job_queue drop constraint if exists job_queue_queue_check;
alter table public.job_queue add constraint job_queue_queue_check
  check (queue in ('notification','ai_analysis','line_event','chat_analysis','case_notification'));

-- =====================================================================
-- RLS: tenant isolation (pattern 0012) — ตารางใหม่ทุกตัวต้องมี
--   worker/scanner เขียนผ่าน service_role (bypass RLS) จึงทำงานได้ปกติ
-- =====================================================================
alter table public.sla_rules            enable row level security;
alter table public.conversation_cases   enable row level security;
alter table public.case_messages        enable row level security;
alter table public.case_status_history  enable row level security;
alter table public.sla_events           enable row level security;
alter table public.risk_alerts          enable row level security;

create policy tenant_isolation on public.sla_rules for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_isolation on public.conversation_cases for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_isolation on public.case_messages for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_isolation on public.case_status_history for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_isolation on public.sla_events for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_isolation on public.risk_alerts for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- =====================================================================
-- GRANT posture (pattern 0013) — ตารางสร้างหลัง 0013 ต้องตั้งชัดเจน
--   anon          : ปฏิเสธทั้งหมด (deny-by-default)
--   authenticated : select/insert/update/delete (RLS คุม row อีกชั้น)
--   service_role  : all (worker/scanner เบื้องหลัง)
-- =====================================================================
revoke all on public.sla_rules            from anon;
revoke all on public.conversation_cases   from anon;
revoke all on public.case_messages        from anon;
revoke all on public.case_status_history  from anon;
revoke all on public.sla_events           from anon;
revoke all on public.risk_alerts          from anon;

grant select, insert, update, delete on public.sla_rules            to authenticated;
grant select, insert, update, delete on public.conversation_cases   to authenticated;
grant select, insert, update, delete on public.case_messages        to authenticated;
grant select, insert, update, delete on public.case_status_history  to authenticated;
grant select, insert, update, delete on public.sla_events           to authenticated;
grant select, insert, update, delete on public.risk_alerts          to authenticated;

grant all on public.sla_rules            to service_role;
grant all on public.conversation_cases   to service_role;
grant all on public.case_messages        to service_role;
grant all on public.case_status_history  to service_role;
grant all on public.sla_events           to service_role;
grant all on public.risk_alerts          to service_role;

-- =====================================================================
-- open_or_update_conversation_case() — เปิด/อัปเดตเคสจากผลวิเคราะห์ แบบ atomic + idempotent
--   1) ถ้ากลุ่มมีเคส active (open/in_progress/waiting_customer/reopened) → อัปเดตเคสเดิม
--      (bump level ถ้ารุนแรงกว่า, refresh summary/urgency, เติม owner/due ถ้ายังว่าง)
--   2) ถ้าไม่มี → เปิดเคสใหม่ + status_history (null→open) + sla_events 'opened'
--   3) โยง case_messages ทุกครั้ง (idempotent ผ่าน unique case_id+chat_message_id)
--   ★ FOR UPDATE ล็อกเคส active กัน race เปิดซ้ำ; ชน uq_conv_cases_active_group = 23505
--   SECURITY DEFINER + fixed search_path; execute เฉพาะ service_role (worker)
-- =====================================================================
create or replace function public.open_or_update_conversation_case(
  p_tenant_id              uuid,
  p_chat_group_id          uuid,
  p_customer_id            uuid,
  p_owner_employee_id      uuid,
  p_title                  text,
  p_summary                text,
  p_urgency                text,
  p_level                  text,
  p_sla_rule_id            uuid,
  p_first_response_due_at  timestamptz,
  p_resolution_due_at      timestamptz,
  p_message_ids            jsonb,
  p_changed_by             uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case_id   uuid;
  v_created   boolean := false;
  v_linked    integer := 0;
begin
  -- ยืนยันว่ากลุ่มอยู่ใน tenant นี้จริง (กันเขียนข้าม tenant)
  perform 1 from public.chat_groups
  where id = p_chat_group_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'chat_group_not_found' using errcode = 'P0002';
  end if;

  -- หาเคส active ของกลุ่ม (ล็อกกันเปิดซ้ำ race)
  select id into v_case_id
  from public.conversation_cases
  where chat_group_id = p_chat_group_id
    and tenant_id = p_tenant_id
    and status in ('open','in_progress','waiting_customer','reopened')
    and deleted_at is null
  order by opened_at desc
  limit 1
  for update;

  if v_case_id is null then
    -- เปิดเคสใหม่
    insert into public.conversation_cases (
      tenant_id, customer_id, chat_group_id, owner_employee_id,
      title, summary, status, urgency, level, source,
      sla_rule_id, first_response_due_at, resolution_due_at, opened_at
    ) values (
      p_tenant_id, p_customer_id, p_chat_group_id, p_owner_employee_id,
      p_title, p_summary, 'open', p_urgency, coalesce(nullif(p_level,''), 'high'), 'chat',
      p_sla_rule_id, p_first_response_due_at, p_resolution_due_at, now()
    )
    returning id into v_case_id;
    v_created := true;

    insert into public.case_status_history (tenant_id, case_id, from_status, to_status, changed_by, note)
    values (p_tenant_id, v_case_id, null, 'open', p_changed_by, 'เปิดเคสจากผลวิเคราะห์แชต');

    insert into public.sla_events (tenant_id, case_id, event_type, occurred_at)
    values (p_tenant_id, v_case_id, 'opened', now())
    on conflict (case_id, event_type) do nothing;
  else
    -- อัปเดตเคสเดิม: bump level ถ้ารุนแรงกว่า, refresh summary/urgency, เติม owner/due ถ้ายังว่าง
    update public.conversation_cases c
    set summary = coalesce(nullif(p_summary,''), c.summary),
        urgency = coalesce(nullif(p_urgency,''), c.urgency),
        level = case
                  when public.case_level_rank(p_level) < public.case_level_rank(c.level)
                    then p_level
                  else c.level
                end,
        owner_employee_id     = coalesce(c.owner_employee_id, p_owner_employee_id),
        sla_rule_id           = coalesce(c.sla_rule_id, p_sla_rule_id),
        first_response_due_at = coalesce(c.first_response_due_at, p_first_response_due_at),
        resolution_due_at     = coalesce(c.resolution_due_at, p_resolution_due_at)
    where c.id = v_case_id;
  end if;

  -- โยง case_messages (idempotent) — เฉพาะ message ที่อยู่ใน tenant เดียวกัน
  if p_message_ids is not null and jsonb_typeof(p_message_ids) = 'array' then
    insert into public.case_messages (tenant_id, case_id, chat_message_id)
    select p_tenant_id, v_case_id, mid
    from (
      select (jsonb_array_elements_text(p_message_ids))::uuid as mid
    ) src
    where exists (
      select 1 from public.chat_messages cm
      where cm.id = src.mid and cm.tenant_id = p_tenant_id
    )
    on conflict (case_id, chat_message_id) do nothing;
    get diagnostics v_linked = row_count;
  end if;

  return jsonb_build_object(
    'case_id', v_case_id,
    'created', v_created,
    'linked_messages', v_linked
  );
end;
$$;

revoke all on function public.open_or_update_conversation_case(uuid,uuid,uuid,uuid,text,text,text,text,uuid,timestamptz,timestamptz,jsonb,uuid) from public;
grant execute on function public.open_or_update_conversation_case(uuid,uuid,uuid,uuid,text,text,text,text,uuid,timestamptz,timestamptz,jsonb,uuid) to service_role;

comment on function public.open_or_update_conversation_case(uuid,uuid,uuid,uuid,text,text,text,text,uuid,timestamptz,timestamptz,jsonb,uuid) is
  'เปิด/อัปเดต conversation_case จากผลวิเคราะห์แชต (idempotent : 1 เคส active/กลุ่ม) + status_history + sla_events opened + โยง case_messages (Phase 3)';
