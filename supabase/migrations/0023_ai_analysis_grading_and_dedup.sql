-- =====================================================================
-- 0022 — เก็บข้อมูลจัดระดับ AI ให้ครบ + กันเปิดเคสซ้ำ + notification pending
--   (แก้ตามผล review/security M2 chunk 2)
--
--   1) ai_feedback_analysis: เพิ่ม urgency_reason / affected / repeat_issue
--      (schema+prompt ผลิตข้อมูลนี้อยู่แล้ว แต่ยังไม่ถูกเก็บลง DB)
--   2) notification_logs.status: อนุญาต 'pending' (แจ้งเตือนยังไม่ส่งจริง)
--   3) complaint_cases: partial unique index (response_id) where deleted_at is null
--      กันเปิดเคสซ้ำต่อ response เดียวกัน (race condition)
--   4) persist_ai_analysis(): CREATE OR REPLACE
--      - เขียน 3 คอลัมน์ใหม่
--      - pg_advisory_xact_lock ต่อ response_id → serialize การเปิดเคส (กัน dup)
--      - insert เคสแบบ on conflict do nothing (backstop unique index)
--      - notification_logs: status='pending', sent_at=null (chunk notification จะส่งจริง)
-- =====================================================================

-- 1) คอลัมน์เก็บข้อมูลจัดระดับ ------------------------------------------------
alter table public.ai_feedback_analysis
  add column if not exists urgency_reason text,
  add column if not exists affected       jsonb not null default '{}'::jsonb,
  add column if not exists repeat_issue    boolean not null default false;

comment on column public.ai_feedback_analysis.urgency_reason is 'เหตุผล+ข้อมูลที่ใช้จัดระดับ urgency (FR-AI-05)';
comment on column public.ai_feedback_analysis.affected is 'ขอบเขตที่ได้รับผลกระทบ {employee,team,service,period}';
comment on column public.ai_feedback_analysis.repeat_issue is 'เป็นปัญหาที่เกิดซ้ำหรือไม่';

-- 2) notification_logs อนุญาต status='pending' -----------------------------
alter table public.notification_logs
  drop constraint if exists notification_logs_status_check;
alter table public.notification_logs
  add constraint notification_logs_status_check
  check (status in ('pending','sent','failed'));

-- 3) กันเปิดเคสซ้ำต่อ response (เฉพาะเคสที่ยังไม่ถูกลบ) ------------------------
create unique index if not exists uq_cases_response_active
  on public.complaint_cases(response_id)
  where deleted_at is null and response_id is not null;

-- 4) persist_ai_analysis — เขียนคอลัมน์ใหม่ + กัน dup + notification pending ---
create or replace function public.persist_ai_analysis(
  p_tenant_id   uuid,
  p_response_id uuid,
  p_analysis    jsonb,      -- ผลลัพธ์เต็ม (summary, sentiment, urgency, urgency_reason, affected, repeat_issue, facts, ... , model, provider, needs_human_review, validated)
  p_open_case   boolean,    -- เปิดเคสหรือไม่ (High/Critical)
  p_case_type   text,       -- complaint|retention|reassign_request|positive
  p_case_level  text,       -- critical|high
  p_sla_due_at  timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_analysis_id  uuid;
  v_customer_id  uuid;
  v_case_id      uuid;
  v_case_no      text;
  v_existing     uuid;
  v_created      boolean := false;
begin
  -- ยืนยันว่า response อยู่ใน tenant นี้จริง (กันเขียนข้าม tenant)
  select customer_id into v_customer_id
  from public.survey_responses
  where id = p_response_id and tenant_id = p_tenant_id and deleted_at is null;

  if not found then
    raise exception 'response_not_found' using errcode = 'P0002';
  end if;

  -- serialize ต่อ response_id ภายใน transaction → กัน worker ซ้อนเปิดเคส/เขียนซ้ำ (release เมื่อ commit)
  perform pg_advisory_xact_lock(hashtext(p_response_id::text));

  -- 1) upsert ai_feedback_analysis (unique response_id)
  insert into public.ai_feedback_analysis (
    tenant_id, response_id, summary, sentiment, urgency, urgency_reason,
    affected, repeat_issue,
    customer_facts, ai_assumptions, evidence, categories,
    next_best_action, draft_reply, confidence,
    model, provider, needs_human_review, validated
  ) values (
    p_tenant_id, p_response_id,
    p_analysis->>'summary',
    p_analysis->>'sentiment',
    p_analysis->>'urgency',
    p_analysis->>'urgency_reason',
    coalesce(p_analysis->'affected', '{}'::jsonb),
    coalesce((p_analysis->>'repeat_issue')::boolean, false),
    coalesce(p_analysis->'customer_facts', '[]'::jsonb),
    coalesce(p_analysis->'ai_assumptions', '[]'::jsonb),
    coalesce(p_analysis->'evidence', '[]'::jsonb),
    coalesce(p_analysis->'categories', '[]'::jsonb),
    p_analysis->>'next_best_action',
    p_analysis->>'draft_reply',
    nullif(p_analysis->>'confidence','')::numeric,
    p_analysis->>'model',
    p_analysis->>'provider',
    coalesce((p_analysis->>'needs_human_review')::boolean, false),
    coalesce((p_analysis->>'validated')::boolean, false)
  )
  on conflict (response_id) do update set
    summary            = excluded.summary,
    sentiment          = excluded.sentiment,
    urgency            = excluded.urgency,
    urgency_reason     = excluded.urgency_reason,
    affected           = excluded.affected,
    repeat_issue       = excluded.repeat_issue,
    customer_facts     = excluded.customer_facts,
    ai_assumptions     = excluded.ai_assumptions,
    evidence           = excluded.evidence,
    categories         = excluded.categories,
    next_best_action   = excluded.next_best_action,
    draft_reply        = excluded.draft_reply,
    confidence         = excluded.confidence,
    model              = excluded.model,
    provider           = excluded.provider,
    needs_human_review = excluded.needs_human_review,
    validated          = excluded.validated,
    updated_at         = now()
  returning id into v_analysis_id;

  -- 2) เปิดเคส (idempotent: ถ้ามีเคสของ response นี้แล้ว ไม่เปิดซ้ำ)
  if p_open_case then
    select id into v_existing
    from public.complaint_cases
    where response_id = p_response_id and deleted_at is null
    limit 1;

    if v_existing is null then
      -- case_no: C-YYYYMMDD-<6 hex> (unique(tenant_id, case_no) เป็น backstop)
      v_case_no := 'C-' || to_char(now(), 'YYYYMMDD') || '-' ||
                   upper(substr(md5(gen_random_uuid()::text), 1, 6));

      -- on conflict do nothing: backstop กับ partial unique index uq_cases_response_active
      insert into public.complaint_cases (
        tenant_id, case_no, response_id, customer_id,
        type, level, status, sla_due_at
      ) values (
        p_tenant_id, v_case_no, p_response_id, v_customer_id,
        p_case_type, p_case_level, 'new', p_sla_due_at
      )
      on conflict (response_id) where deleted_at is null and response_id is not null
      do nothing
      returning id into v_case_id;

      if v_case_id is not null then
        -- timeline: เปิดเคสโดยระบบ (actor = null = system)
        insert into public.case_activity_logs (tenant_id, case_id, actor_user_id, action, note)
        values (p_tenant_id, v_case_id, null, 'auto_opened',
                'เปิดเคสอัตโนมัติจากผลวิเคราะห์ AI (urgency=' || p_case_level || ')');

        -- แจ้งเตือน (dashboard) — status='pending' เพราะยังไม่ส่งจริง
        --   chunk notification worker จะเปลี่ยนเป็น 'sent'/'failed' + set sent_at
        insert into public.notification_logs (
          tenant_id, target, channel, ref_type, ref_id, status, sent_at
        ) values (
          p_tenant_id, 'employee', 'dashboard', 'case', v_case_id, 'pending', null
        );

        v_created := true;
      else
        -- แพ้ race (มีเคส active อยู่แล้ว) → ดึงเคสเดิมมาคืน
        select id into v_case_id
        from public.complaint_cases
        where response_id = p_response_id and deleted_at is null
        limit 1;
      end if;
    else
      v_case_id := v_existing;
    end if;
  end if;

  return jsonb_build_object(
    'analysis_id', v_analysis_id,
    'case_id',     v_case_id,
    'case_no',     v_case_no,
    'case_created', v_created
  );
end;
$$;

revoke all on function public.persist_ai_analysis(uuid,uuid,jsonb,boolean,text,text,timestamptz) from public;
grant execute on function public.persist_ai_analysis(uuid,uuid,jsonb,boolean,text,text,timestamptz) to service_role;

comment on function public.persist_ai_analysis(uuid,uuid,jsonb,boolean,text,text,timestamptz) is
  'บันทึกผลวิเคราะห์ AI (รวมข้อมูลจัดระดับ) + เปิดเคสอัตโนมัติแบบกัน dup (advisory lock + partial unique index); notification=pending (M2 chunk 2, rev 0022)';

-- =====================================================================
-- TODO (เลื่อนตาม scope):
--   * Medium urgency → สร้าง follow_up_tasks (M5) — ยังไม่ทำในรอบนี้
--   * ปรับ redact ชื่อ over-redact + retry case_no ชน unique (Low) — ยังไม่ทำ
-- =====================================================================
