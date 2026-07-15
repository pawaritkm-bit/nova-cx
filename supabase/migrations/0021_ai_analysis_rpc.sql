-- =====================================================================
-- 0021 — Atomic persist ผลวิเคราะห์ AI + เปิดเคสอัตโนมัติ (M2 chunk 2)
--   persist_ai_analysis(): เขียน ai_feedback_analysis (upsert ต่อ response)
--     + ถ้า High/Critical → เปิด complaint_cases + case_activity_logs (system)
--       + notification_logs (dashboard) ใน transaction เดียว
--   SECURITY DEFINER + fixed search_path; execute เฉพาะ service_role (worker)
-- =====================================================================

create or replace function public.persist_ai_analysis(
  p_tenant_id   uuid,
  p_response_id uuid,
  p_analysis    jsonb,      -- ผลลัพธ์เต็ม (summary, sentiment, urgency, facts, ... , model, provider, needs_human_review, validated)
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

  -- 1) upsert ai_feedback_analysis (unique response_id)
  insert into public.ai_feedback_analysis (
    tenant_id, response_id, summary, sentiment, urgency,
    customer_facts, ai_assumptions, evidence, categories,
    next_best_action, draft_reply, confidence,
    model, provider, needs_human_review, validated
  ) values (
    p_tenant_id, p_response_id,
    p_analysis->>'summary',
    p_analysis->>'sentiment',
    p_analysis->>'urgency',
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

      insert into public.complaint_cases (
        tenant_id, case_no, response_id, customer_id,
        type, level, status, sla_due_at
      ) values (
        p_tenant_id, v_case_no, p_response_id, v_customer_id,
        p_case_type, p_case_level, 'new', p_sla_due_at
      )
      returning id into v_case_id;

      -- timeline: เปิดเคสโดยระบบ (actor = null = system)
      insert into public.case_activity_logs (tenant_id, case_id, actor_user_id, action, note)
      values (p_tenant_id, v_case_id, null, 'auto_opened',
              'เปิดเคสอัตโนมัติจากผลวิเคราะห์ AI (urgency=' || p_case_level || ')');

      -- แจ้งเตือน (dashboard) — LINE push จริงทำใน chunk notification worker
      insert into public.notification_logs (
        tenant_id, target, channel, ref_type, ref_id, status, sent_at
      ) values (
        p_tenant_id, 'employee', 'dashboard', 'case', v_case_id, 'sent', now()
      );

      v_created := true;
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
  'บันทึกผลวิเคราะห์ AI + เปิดเคสอัตโนมัติ (High/Critical) แบบ atomic (M2 chunk 2)';
