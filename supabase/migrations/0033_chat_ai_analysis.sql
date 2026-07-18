-- =====================================================================
-- 0033 — Chat AI Analysis (Phase 2) : วิเคราะห์บทสนทนากลุ่ม LINE ที่เก็บไว้
--   ต่อจาก 0032 (chat ingestion : chat_groups/members/messages/attachments)
--
-- โมดูล "AI วิเคราะห์แชท+ประเมินนักบัญชี" — Phase 2:
--   เอาแชตที่เก็บไว้ (ciphertext) → worker ถอดรหัส (server) → redact → gate →
--   ส่ง AI → วิเคราะห์ flow งาน / จับปัญหา / sentiment / SOP violation →
--   บันทึกผลลง ai_chat_analysis + customer_sentiment + sop_violations (atomic RPC)
--
-- ★ วิเคราะห์เป็น "ช่วงบทสนทนา" (window) ต่อ chat_group — ไม่วิเคราะห์ทีละข้อความ
--   (ประหยัดต้นทุน AI: รวมข้อความที่ยังไม่วิเคราะห์เป็น 1 batch/กลุ่ม)
--
-- non-destructive:
--   - สร้างตารางใหม่ 3 ตัว (ai_chat_analysis / customer_sentiment / sop_violations)
--   - ALTER chat_messages ADD COLUMN analyzed_at (nullable) — เครื่องหมายว่าเข้ารอบวิเคราะห์แล้ว
--   - ALTER job_queue CHECK เพิ่มค่า 'chat_analysis' (คงค่าเดิมครบ)
--   - เพิ่ม RPC persist_chat_analysis() (ใหม่ ไม่ทับ persist_ai_analysis เดิมของ survey)
--   ไม่แตะตาราง/RPC/AI ของ survey เดิม / ไม่แตะ pseudonymity (0025/0027)
-- =====================================================================

-- ---------------------------------------------------------------------
-- chat_messages: analyzed_at — เวลาที่ข้อความถูกรวมเข้ารอบวิเคราะห์ AI แล้ว
--   null = ยังไม่วิเคราะห์ (scan จะหยิบไปทำ window ถัดไป)
--   ★ additive: คอลัมน์ใหม่ nullable ไม่กระทบ ingest เดิม
-- ---------------------------------------------------------------------
alter table public.chat_messages
  add column if not exists analyzed_at timestamptz;

-- ดัชนีบางส่วน: เร่ง scan หากลุ่มที่ยังมีข้อความค้างวิเคราะห์
create index if not exists idx_chat_messages_unanalyzed
  on public.chat_messages(chat_group_id, sent_at)
  where analyzed_at is null and deleted_at is null;

-- ---------------------------------------------------------------------
-- ai_chat_analysis — ผลวิเคราะห์บทสนทนา 1 window (ลอกโครง ai_feedback_analysis 0007)
--   window_start/window_end : ช่วงเวลาบทสนทนาที่วิเคราะห์
--   message_ids             : รายการ message id ที่อยู่ใน window (อ้างอิงย้อนกลับ)
--   customer_facts/ai_assumptions/evidence : ★ แยกข้อเท็จจริง(อ้างข้อความ+เวลา) vs สันนิษฐาน
--   flow_steps  : ผล flow งาน (รับเรื่อง/ตอบ/เวลาตอบ/เข้าใจโจทย์/กำหนดเสร็จ/ดำเนินการ/อัปเดต/ปิด)
--   problems    : ปัญหาที่จับได้ (ตอบช้า/ตกหล่น/ไม่มี owner/ขอเอกสารซ้ำ/ตอบไม่ตรง/ศัพท์ยาก/ห้วน/ข้อมูลขัดแย้ง)
--   insufficient_data : true = ข้อมูลไม่พอสรุป (บทสนทนาสั้น/ไม่มีบริบท)
-- ---------------------------------------------------------------------
create table if not exists public.ai_chat_analysis (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  chat_group_id       uuid not null references public.chat_groups(id) on delete cascade,
  window_start        timestamptz,
  window_end          timestamptz,
  message_count       integer not null default 0,
  message_ids         jsonb not null default '[]'::jsonb,
  summary             text,
  sentiment           text check (sentiment in ('positive','neutral','negative')),
  urgency             text check (urgency in ('critical','high','medium','low')),
  customer_facts      jsonb not null default '[]'::jsonb,  -- ★ ข้อเท็จจริง (อ้างข้อความ+เวลา)
  ai_assumptions      jsonb not null default '[]'::jsonb,  -- ★ ข้อสันนิษฐาน AI
  evidence            jsonb not null default '[]'::jsonb,  -- ★ อ้าง message_id + เวลา
  flow_steps          jsonb not null default '[]'::jsonb,  -- ★ ผล flow งาน
  problems            jsonb not null default '[]'::jsonb,  -- ★ ปัญหาที่จับได้
  confidence          numeric(4,3),
  model               text,
  provider            text,
  needs_human_review  boolean not null default false,
  insufficient_data   boolean not null default false,      -- ★ ข้อมูลไม่เพียงพอ
  -- ★ marker เมื่อถูกบล็อก (เช่น residual PII หลุด redact) — ผู้ตรวจ re-queue เองได้ ไม่วิเคราะห์ใหม่อัตโนมัติ
  blocked_reason      text,
  validated           boolean not null default false,      -- ผ่าน Zod หรือไม่
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create index if not exists idx_ai_chat_analysis_tenant on public.ai_chat_analysis(tenant_id);
create index if not exists idx_ai_chat_analysis_group on public.ai_chat_analysis(chat_group_id, window_end);
create index if not exists idx_ai_chat_analysis_urgency on public.ai_chat_analysis(urgency);
create trigger trg_ai_chat_analysis_updated before update on public.ai_chat_analysis
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- customer_sentiment — เทรนด์ sentiment ต่อ chat_group/ช่วงเวลา (score/label/at)
--   1 แถวต่อ 1 จุดวัด (window อาจให้หลายจุด) → ใช้พล็อตแนวโน้มความรู้สึกลูกค้า
--   score : -1.0 (ลบมาก) .. 1.0 (บวกมาก)
-- ---------------------------------------------------------------------
create table if not exists public.customer_sentiment (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  chat_group_id  uuid not null references public.chat_groups(id) on delete cascade,
  analysis_id    uuid references public.ai_chat_analysis(id) on delete set null,
  score          numeric(4,3) not null,
  label          text not null check (label in ('positive','neutral','negative')),
  at             timestamptz not null,
  created_at     timestamptz not null default now()
);
create index if not exists idx_customer_sentiment_tenant on public.customer_sentiment(tenant_id);
create index if not exists idx_customer_sentiment_group_at on public.customer_sentiment(chat_group_id, at);

-- ---------------------------------------------------------------------
-- sop_violations — ประเด็นผิด SOP ที่ตรวจพบ (ผูก analysis + อ้าง message)
--   violation_type : slow_reply | missed_request | no_owner | repeat_doc_request |
--                    off_topic_reply | jargon | terse_reply | conflicting_info | other
--   severity       : low | medium | high
--   evidence_message_id : ข้อความหลักฐาน (nullable — บาง violation เป็นภาพรวม)
--   needs_expert_review : ★ เรื่องบัญชี/ภาษีเสี่ยงสูง → flag ส่งผู้เชี่ยวชาญ
-- ---------------------------------------------------------------------
create table if not exists public.sop_violations (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  chat_analysis_id    uuid not null references public.ai_chat_analysis(id) on delete cascade,
  chat_group_id       uuid not null references public.chat_groups(id) on delete cascade,
  violation_type      text not null,
  severity            text not null default 'low' check (severity in ('low','medium','high')),
  evidence_message_id uuid references public.chat_messages(id) on delete set null,
  description         text,
  needs_expert_review boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create index if not exists idx_sop_violations_tenant on public.sop_violations(tenant_id);
create index if not exists idx_sop_violations_analysis on public.sop_violations(chat_analysis_id);
create index if not exists idx_sop_violations_group on public.sop_violations(chat_group_id);
create trigger trg_sop_violations_updated before update on public.sop_violations
  for each row execute function public.set_updated_at();

-- =====================================================================
-- job_queue.queue CHECK : เพิ่ม 'chat_analysis' (คงค่าเดิมครบ)
--   inline check ของ 0009 ถูกตั้งชื่อ job_queue_queue_check โดย Postgres
-- =====================================================================
alter table public.job_queue drop constraint if exists job_queue_queue_check;
alter table public.job_queue add constraint job_queue_queue_check
  check (queue in ('notification','ai_analysis','line_event','chat_analysis'));

-- ★ กัน job chat_analysis ซ้อนต่อกลุ่ม (cron overlap/reclaim) ตั้งแต่ชั้น DB
--   อนุญาต pending/processing ได้แค่ 1 งานต่อ chat_group_id — chat-scan จับ 23505 → skip
create unique index if not exists uq_job_queue_chat_analysis_active
  on public.job_queue ((payload->>'chat_group_id'))
  where queue = 'chat_analysis' and status in ('pending','processing');

-- =====================================================================
-- RLS: tenant isolation (pattern 0012) — ตารางใหม่ทุกตัวต้องมี
--   worker เขียนผ่าน service_role (bypass RLS) จึงทำงานได้ปกติ
-- =====================================================================
alter table public.ai_chat_analysis   enable row level security;
alter table public.customer_sentiment enable row level security;
alter table public.sop_violations     enable row level security;

create policy tenant_isolation on public.ai_chat_analysis for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_isolation on public.customer_sentiment for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_isolation on public.sop_violations for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- =====================================================================
-- GRANT posture (pattern 0013) — ตารางสร้างหลัง 0013 ต้องตั้งชัดเจน
--   anon          : ปฏิเสธทั้งหมด (deny-by-default)
--   authenticated : ★ SELECT เท่านั้น — เขียนผ่าน service_role/RPC (worker) เท่านั้น
--   service_role  : all (worker เบื้องหลัง)
--
-- ★ security-M1 (Phase 5a review): ผลวิเคราะห์ AI เขียนผ่าน persist_chat_analysis()
--   (service_role) เท่านั้น → revoke insert/update/delete จาก authenticated กันปลอมผลวิเคราะห์
--   ตรงผ่าน PostgREST (การอ่านข้าม team ระดับ SELECT ยอมรับได้ในเฟสนี้ = follow-up owner/team RLS)
-- =====================================================================
revoke all on public.ai_chat_analysis   from anon;
revoke all on public.customer_sentiment from anon;
revoke all on public.sop_violations     from anon;

grant select on public.ai_chat_analysis   to authenticated;
grant select on public.customer_sentiment to authenticated;
grant select on public.sop_violations     to authenticated;

grant all on public.ai_chat_analysis   to service_role;
grant all on public.customer_sentiment to service_role;
grant all on public.sop_violations     to service_role;

-- =====================================================================
-- persist_chat_analysis() — บันทึกผลวิเคราะห์บทสนทนา 1 window แบบ atomic
--   1) insert ai_chat_analysis
--   2) insert customer_sentiment (หลายจุดตาม p_sentiment_points)
--   3) insert sop_violations (หลายรายการตาม p_violations)
--   4) mark chat_messages.analyzed_at = now สำหรับ message ids ใน window
--      (idempotency: retry รอบหน้าจะไม่หยิบข้อความเดิมมาวิเคราะห์ซ้ำ)
--   SECURITY DEFINER + fixed search_path; execute เฉพาะ service_role (worker)
-- =====================================================================
create or replace function public.persist_chat_analysis(
  p_tenant_id         uuid,
  p_chat_group_id     uuid,
  p_window_start      timestamptz,
  p_window_end        timestamptz,
  p_message_ids       jsonb,   -- array ของ message uuid (string)
  p_analysis          jsonb,   -- summary/sentiment/urgency/facts/assumptions/evidence/flow_steps/problems/confidence/model/provider/needs_human_review/insufficient_data/validated
  p_sentiment_points  jsonb,   -- array ของ {score, label, at}
  p_violations        jsonb    -- array ของ {violation_type, severity, evidence_message_id, description, needs_expert_review}
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_analysis_id  uuid;
  v_count        integer;
  v_unanalyzed   integer := 0;
  v_marked       integer := 0;
  v_pt           jsonb;
  v_vi           jsonb;
  v_ev_msg       uuid;
begin
  -- ยืนยันว่ากลุ่มอยู่ใน tenant นี้จริง (กันเขียนข้าม tenant)
  perform 1 from public.chat_groups
  where id = p_chat_group_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'chat_group_not_found' using errcode = 'P0002';
  end if;

  v_count := coalesce(jsonb_array_length(p_message_ids), 0);

  -- ★ idempotency guard (rev-H1/sec-G2): ล็อกแถวข้อความใน window แบบ FOR UPDATE
  --   นับเฉพาะที่ยัง analyzed_at IS NULL — ถ้า 0 = window นี้ถูก cron อื่นวิเคราะห์ไปแล้ว
  --   → return no-op (ไม่ insert ซ้ำ, ไม่จ่าย AI ซ้ำ, ไม่สร้าง analysis ซ้ำ)
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

  -- 1) insert ผลวิเคราะห์
  insert into public.ai_chat_analysis (
    tenant_id, chat_group_id, window_start, window_end, message_count, message_ids,
    summary, sentiment, urgency,
    customer_facts, ai_assumptions, evidence, flow_steps, problems,
    confidence, model, provider, needs_human_review, insufficient_data, blocked_reason, validated
  ) values (
    p_tenant_id, p_chat_group_id, p_window_start, p_window_end, v_count,
    coalesce(p_message_ids, '[]'::jsonb),
    p_analysis->>'summary',
    p_analysis->>'sentiment',
    p_analysis->>'urgency',
    coalesce(p_analysis->'customer_facts', '[]'::jsonb),
    coalesce(p_analysis->'ai_assumptions', '[]'::jsonb),
    coalesce(p_analysis->'evidence', '[]'::jsonb),
    coalesce(p_analysis->'flow_steps', '[]'::jsonb),
    coalesce(p_analysis->'problems', '[]'::jsonb),
    nullif(p_analysis->>'confidence','')::numeric,
    p_analysis->>'model',
    p_analysis->>'provider',
    coalesce((p_analysis->>'needs_human_review')::boolean, false),
    coalesce((p_analysis->>'insufficient_data')::boolean, false),
    nullif(p_analysis->>'blocked_reason',''),
    coalesce((p_analysis->>'validated')::boolean, false)
  )
  returning id into v_analysis_id;

  -- 2) customer_sentiment (เทรนด์) — ข้ามรายการที่ไม่มี at/score
  if p_sentiment_points is not null and jsonb_typeof(p_sentiment_points) = 'array' then
    for v_pt in select * from jsonb_array_elements(p_sentiment_points)
    loop
      if (v_pt ? 'at') and nullif(v_pt->>'at','') is not null
         and (v_pt ? 'score') and nullif(v_pt->>'score','') is not null then
        insert into public.customer_sentiment (
          tenant_id, chat_group_id, analysis_id, score, label, at
        ) values (
          p_tenant_id, p_chat_group_id, v_analysis_id,
          (v_pt->>'score')::numeric,
          coalesce(nullif(v_pt->>'label',''), 'neutral'),
          (v_pt->>'at')::timestamptz
        );
      end if;
    end loop;
  end if;

  -- 3) sop_violations — evidence_message_id ยืนยันว่าอยู่ใน tenant เดียวกัน (best-effort)
  if p_violations is not null and jsonb_typeof(p_violations) = 'array' then
    for v_vi in select * from jsonb_array_elements(p_violations)
    loop
      v_ev_msg := null;
      if (v_vi ? 'evidence_message_id') and nullif(v_vi->>'evidence_message_id','') is not null then
        select id into v_ev_msg from public.chat_messages
        where id = (v_vi->>'evidence_message_id')::uuid and tenant_id = p_tenant_id;
      end if;
      insert into public.sop_violations (
        tenant_id, chat_analysis_id, chat_group_id,
        violation_type, severity, evidence_message_id, description, needs_expert_review
      ) values (
        p_tenant_id, v_analysis_id, p_chat_group_id,
        coalesce(nullif(v_vi->>'violation_type',''), 'other'),
        coalesce(nullif(v_vi->>'severity',''), 'low'),
        v_ev_msg,
        v_vi->>'description',
        coalesce((v_vi->>'needs_expert_review')::boolean, false)
      );
    end loop;
  end if;

  -- 4) mark ข้อความใน window ว่าวิเคราะห์แล้ว (idempotency กันวิเคราะห์ซ้ำ)
  if v_count > 0 then
    update public.chat_messages
    set analyzed_at = now()
    where tenant_id = p_tenant_id
      and chat_group_id = p_chat_group_id   -- rev-G1: defense-in-depth (จำกัดเฉพาะกลุ่มนี้)
      and analyzed_at is null
      and id in (
        select (jsonb_array_elements_text(p_message_ids))::uuid
      );
    get diagnostics v_marked = row_count;
  end if;

  return jsonb_build_object(
    'analysis_id', v_analysis_id,
    'message_count', v_count,
    'marked_analyzed', v_marked
  );
end;
$$;

revoke all on function public.persist_chat_analysis(uuid,uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb,jsonb) from public;
grant execute on function public.persist_chat_analysis(uuid,uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb,jsonb) to service_role;

comment on function public.persist_chat_analysis(uuid,uuid,timestamptz,timestamptz,jsonb,jsonb,jsonb,jsonb) is
  'บันทึกผลวิเคราะห์บทสนทนา 1 window (ai_chat_analysis + customer_sentiment + sop_violations) + mark analyzed แบบ atomic (Phase 2)';
