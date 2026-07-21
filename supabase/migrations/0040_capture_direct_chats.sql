-- =====================================================================
-- 0040 — Capture Direct (1-1) Chats : เก็บ + วิเคราะห์แชต 1-1 (ลูกค้า ↔ OA)
--   Phase A ของโมดูล "ประเมินสำนักงาน (office inbound)"
--
-- บริบท/ข้อจำกัด LINE (สำคัญ):
--   - webhook 1-1 ส่งให้เฉพาะข้อความ "ขาเข้าจากลูกค้า" เท่านั้น
--     ข้อความที่ OA/พนักงานตอบกลับใน 1-1 เรา "ไม่เห็น" และ "ระบุนักบัญชีรายคนไม่ได้"
--   - ดังนั้น 1-1 = วิเคราะห์ "ฝั่งลูกค้า" ล้วน (สัญญาณลูกค้า)
--     ★ ห้ามผูก/ประเมินนักบัญชีรายคนใน 1-1 เด็ดขาด
--
-- decision (กันการปนเปื้อนกับ flow ประเมินนักบัญชีรายคน):
--   - เก็บผลวิเคราะห์ 1-1 ใน "ตารางแยก" office_inbound_analysis
--     ★ ไม่ใช้ ai_chat_analysis ปนกับผลของกลุ่ม (กัน per-accountant flow หยิบไปโดยไม่ตั้งใจ)
--   - บทสนทนา 1-1 เก็บใน chat_groups เดิม แต่ group_kind='user' (คีย์ต่อ userId)
--     → routing แยกที่ scan/worker: 'user' → office queue, 'group'/'room' → per-accountant queue
--
-- non-destructive:
--   - ALTER chat_groups.group_kind CHECK เพิ่มค่า 'user' (คงค่าเดิม group/room)
--   - ALTER job_queue.queue CHECK เพิ่มค่า 'office_inbound' (คงค่าเดิมครบ)
--   - สร้างตารางใหม่ office_inbound_analysis (+ RLS tenant_isolation + grant posture)
--   - partial unique index กัน job office_inbound ซ้อนต่อบทสนทนา
--   - เพิ่ม RPC persist_office_inbound_analysis() (ใหม่ ไม่ทับ persist_chat_analysis เดิม)
--   ไม่แตะตาราง/RPC ของกลุ่ม (ai_chat_analysis/sop_violations/persist_chat_analysis)
-- =====================================================================

-- ---------------------------------------------------------------------
-- chat_groups.group_kind : เพิ่มค่า 'user' (บทสนทนา 1-1)
--   เดิม (0032): check (group_kind in ('group','room'))
--   inline check ถูกตั้งชื่อ chat_groups_group_kind_check โดย Postgres
-- ---------------------------------------------------------------------
alter table public.chat_groups drop constraint if exists chat_groups_group_kind_check;
alter table public.chat_groups add constraint chat_groups_group_kind_check
  check (group_kind in ('group', 'room', 'user'));

-- ---------------------------------------------------------------------
-- job_queue.queue : เพิ่มค่า 'office_inbound' (คงค่าเดิมครบ)
--   ค่าเดิมสะสมถึง 0035: notification/ai_analysis/line_event/chat_analysis/case_notification/evaluation
-- ---------------------------------------------------------------------
alter table public.job_queue drop constraint if exists job_queue_queue_check;
alter table public.job_queue add constraint job_queue_queue_check
  check (queue in ('notification','ai_analysis','line_event','chat_analysis',
                   'case_notification','evaluation','office_inbound'));

-- ★ กัน job office_inbound ซ้อนต่อบทสนทนา (cron overlap/reclaim) ตั้งแต่ชั้น DB
--   อนุญาต pending/processing ได้แค่ 1 งานต่อ chat_group_id — office scan จับ 23505 → skip
create unique index if not exists uq_job_queue_office_inbound_active
  on public.job_queue ((payload->>'chat_group_id'))
  where queue = 'office_inbound' and status in ('pending','processing');

-- ---------------------------------------------------------------------
-- office_inbound_analysis — ผลวิเคราะห์ "ฝั่งลูกค้า" ของบทสนทนา 1-1 (1 window)
--   ★ per conversation (chat_group_id ของ group_kind='user') — ไม่ผูกนักบัญชีรายคน
--   sentiment      : positive|neutral|negative (ฝั่งลูกค้า)
--   urgency        : critical|high|medium|low
--   topics         : หัวข้อที่ลูกค้าพูดถึง (array ของ string)
--   is_complaint   : บทสนทนานี้เป็นการร้องเรียน/ตำหนิหรือไม่
--   needs_attention: ต้องให้เจ้าหน้าที่ดูด่วน (ลูกค้าโมโห/เร่งด่วน) — flag ในตารางนี้พอ
--                    ★ ไม่ยุ่ง conversation_cases/risk_alerts ของ per-accountant
-- ---------------------------------------------------------------------
create table if not exists public.office_inbound_analysis (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  chat_group_id    uuid not null references public.chat_groups(id) on delete cascade,
  window_start     timestamptz,
  window_end       timestamptz,
  message_count    integer not null default 0,
  message_ids      jsonb not null default '[]'::jsonb,
  summary          text,
  sentiment        text check (sentiment in ('positive','neutral','negative')),
  urgency          text check (urgency in ('critical','high','medium','low')),
  topics           jsonb not null default '[]'::jsonb,
  is_complaint     boolean not null default false,
  needs_attention  boolean not null default false,
  confidence       numeric(4,3),
  model            text,
  provider         text,
  -- ★ marker เมื่อถูกบล็อก (residual PII หลุด redact) — ผู้ตรวจ re-queue เอง ไม่วิเคราะห์ใหม่อัตโนมัติ
  blocked_reason   text,
  validated        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists idx_office_inbound_analysis_tenant on public.office_inbound_analysis(tenant_id);
create index if not exists idx_office_inbound_analysis_group  on public.office_inbound_analysis(chat_group_id, window_end);
create index if not exists idx_office_inbound_analysis_attn   on public.office_inbound_analysis(needs_attention)
  where needs_attention = true and deleted_at is null;

create trigger trg_office_inbound_analysis_updated before update on public.office_inbound_analysis
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS: tenant isolation (pattern 0012) — ตารางใหม่ต้องมี
--   worker เขียนผ่าน service_role (bypass RLS) จึงทำงานได้ปกติ
-- =====================================================================
alter table public.office_inbound_analysis enable row level security;

create policy tenant_isolation on public.office_inbound_analysis for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- =====================================================================
-- GRANT posture (pattern 0013) — ตารางสร้างหลัง 0013 ต้องตั้งชัดเจน
--   anon          : ปฏิเสธทั้งหมด (deny-by-default)
--   authenticated : ★ SELECT เท่านั้น — เขียนผ่าน service_role/RPC (worker) เท่านั้น
--   service_role  : all (worker เบื้องหลัง)
-- =====================================================================
revoke all on public.office_inbound_analysis from anon;
grant select on public.office_inbound_analysis to authenticated;
grant all    on public.office_inbound_analysis to service_role;

-- =====================================================================
-- persist_office_inbound_analysis() — บันทึกผลวิเคราะห์ 1-1 (1 window) แบบ atomic
--   1) ยืนยัน chat_group อยู่ใน tenant + group_kind='user' (กันเขียนผิดชนิดกลุ่ม/ข้าม tenant)
--   2) idempotency guard: ล็อกข้อความใน window (FOR UPDATE) — ถ้าไม่มี unanalyzed = no-op
--   3) insert office_inbound_analysis
--   4) mark chat_messages.analyzed_at ของ message ids ใน window
--   SECURITY DEFINER + fixed search_path; execute เฉพาะ service_role (worker)
-- =====================================================================
create or replace function public.persist_office_inbound_analysis(
  p_tenant_id      uuid,
  p_chat_group_id  uuid,
  p_window_start   timestamptz,
  p_window_end     timestamptz,
  p_message_ids    jsonb,   -- array ของ message uuid (string)
  p_analysis       jsonb    -- summary/sentiment/urgency/topics/is_complaint/needs_attention/confidence/model/provider/blocked_reason/validated
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_analysis_id uuid;
  v_count       integer;
  v_unanalyzed  integer := 0;
  v_marked      integer := 0;
begin
  -- 1) ยืนยันกลุ่มอยู่ใน tenant นี้ + เป็นบทสนทนา 1-1 (group_kind='user')
  --    ★ กันเขียนผล office ทับกลุ่ม/ห้อง (per-accountant) โดยไม่ตั้งใจ
  perform 1 from public.chat_groups
  where id = p_chat_group_id and tenant_id = p_tenant_id and group_kind = 'user';
  if not found then
    raise exception 'office_group_not_found_or_not_direct' using errcode = 'P0002';
  end if;

  v_count := coalesce(jsonb_array_length(p_message_ids), 0);

  -- 2) idempotency guard: นับเฉพาะข้อความที่ยัง analyzed_at IS NULL (ล็อก FOR UPDATE)
  --    ถ้า 0 = window นี้ถูกวิเคราะห์ไปแล้ว → no-op (ไม่ insert ซ้ำ/ไม่จ่าย AI ซ้ำ)
  if v_count > 0 then
    select count(*) into v_unanalyzed
    from public.chat_messages
    where tenant_id = p_tenant_id
      and chat_group_id = p_chat_group_id
      and analyzed_at is null
      and id in (select (jsonb_array_elements_text(p_message_ids))::uuid)
    for update;

    if v_unanalyzed = 0 then
      return jsonb_build_object(
        'analysis_id', null,
        'message_count', v_count,
        'marked_analyzed', 0,
        'noop', true
      );
    end if;
  end if;

  -- 3) insert ผลวิเคราะห์ฝั่งลูกค้า
  insert into public.office_inbound_analysis (
    tenant_id, chat_group_id, window_start, window_end, message_count, message_ids,
    summary, sentiment, urgency, topics, is_complaint, needs_attention,
    confidence, model, provider, blocked_reason, validated
  ) values (
    p_tenant_id, p_chat_group_id, p_window_start, p_window_end, v_count,
    coalesce(p_message_ids, '[]'::jsonb),
    p_analysis->>'summary',
    p_analysis->>'sentiment',
    p_analysis->>'urgency',
    coalesce(p_analysis->'topics', '[]'::jsonb),
    coalesce((p_analysis->>'is_complaint')::boolean, false),
    coalesce((p_analysis->>'needs_attention')::boolean, false),
    nullif(p_analysis->>'confidence','')::numeric,
    p_analysis->>'model',
    p_analysis->>'provider',
    nullif(p_analysis->>'blocked_reason',''),
    coalesce((p_analysis->>'validated')::boolean, false)
  )
  returning id into v_analysis_id;

  -- 4) mark ข้อความใน window ว่าวิเคราะห์แล้ว (idempotency กันวิเคราะห์ซ้ำ)
  if v_count > 0 then
    update public.chat_messages
    set analyzed_at = now()
    where tenant_id = p_tenant_id
      and chat_group_id = p_chat_group_id
      and analyzed_at is null
      and id in (select (jsonb_array_elements_text(p_message_ids))::uuid);
    get diagnostics v_marked = row_count;
  end if;

  return jsonb_build_object(
    'analysis_id', v_analysis_id,
    'message_count', v_count,
    'marked_analyzed', v_marked
  );
end;
$$;

revoke all on function public.persist_office_inbound_analysis(uuid,uuid,timestamptz,timestamptz,jsonb,jsonb) from public;
grant execute on function public.persist_office_inbound_analysis(uuid,uuid,timestamptz,timestamptz,jsonb,jsonb) to service_role;

comment on function public.persist_office_inbound_analysis(uuid,uuid,timestamptz,timestamptz,jsonb,jsonb) is
  'บันทึกผลวิเคราะห์บทสนทนา 1-1 ฝั่งลูกค้า 1 window (office_inbound_analysis) + mark analyzed แบบ atomic (Phase A)';

-- ให้ PostgREST รีโหลด schema cache (ตารางใหม่/คอลัมน์ใหม่/RPC ใหม่จะเห็นทันที)
notify pgrst, 'reload schema';
