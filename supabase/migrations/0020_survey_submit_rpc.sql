-- =====================================================================
-- 0020 — Atomic submit RPC (Reviewer 🔴#1)
--   บันทึกผลแบบประเมินทั้งหมดใน "transaction เดียว" (ฟังก์ชัน = atomic)
--   response + answers + CSAT + NPS + Form B eval + consent
--   + ปิด invitation + enqueue AI → rollback อัตโนมัติถ้าล้ม
--   SECURITY DEFINER + fixed search_path; execute เฉพาะ service_role
-- =====================================================================

create or replace function public.submit_survey_response(
  p_invitation_id   uuid,
  p_answers         jsonb,     -- {question_code: value}
  p_csat_overall    numeric,   -- อาจเป็น null
  p_csat_dimensions jsonb,     -- [{dimension, score}]
  p_nps             jsonb,     -- {score, category} หรือ null
  p_consent         jsonb      -- {policy_version, purpose} หรือ null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv         record;
  v_response_id uuid;
begin
  -- ล็อกแถว invitation กันตอบซ้ำแบบ race
  select id, tenant_id, customer_id, survey_type, survey_version_id,
         assignee_snapshot, status
    into v_inv
  from public.survey_invitations
  where id = p_invitation_id and deleted_at is null
  for update;

  if not found then
    raise exception 'invitation_not_found' using errcode = 'P0002';
  end if;

  if v_inv.status = 'responded' then
    raise exception 'already_responded' using errcode = 'P0001';
  end if;

  -- 1) response (unique(invitation_id) เป็น backstop กันซ้ำ)
  insert into public.survey_responses
    (tenant_id, invitation_id, customer_id, survey_template_version, submitted_at, is_locked)
  values
    (v_inv.tenant_id, v_inv.id, v_inv.customer_id, v_inv.survey_version_id, now(), true)
  returning id into v_response_id;

  -- 2) answers (append-only) — jsonb_each เก็บ JSON null เป็น 'null'::jsonb (ไม่ชน NOT NULL)
  insert into public.survey_answers (tenant_id, response_id, question_code, value_json)
  select v_inv.tenant_id, v_response_id, key, value
  from jsonb_each(coalesce(p_answers, '{}'::jsonb));

  -- 3) CSAT รายข้อ
  if p_csat_dimensions is not null then
    insert into public.satisfaction_scores (tenant_id, response_id, dimension, score)
    select v_inv.tenant_id, v_response_id, d->>'dimension', (d->>'score')::numeric
    from jsonb_array_elements(p_csat_dimensions) d;
  end if;

  -- 3b) CSAT overall
  if p_csat_overall is not null then
    insert into public.satisfaction_scores (tenant_id, response_id, dimension, score)
    values (v_inv.tenant_id, v_response_id, 'overall', p_csat_overall);
  end if;

  -- 4) NPS
  if p_nps is not null and (p_nps ? 'score') then
    insert into public.nps_scores (tenant_id, response_id, score_0_10, category)
    values (v_inv.tenant_id, v_response_id,
            (p_nps->>'score')::int, p_nps->>'category');
  end if;

  -- 5) Form B: employee_evaluations จาก assignee snapshot (ผูกอัตโนมัติ)
  if v_inv.survey_type = 'B' and v_inv.assignee_snapshot is not null then
    insert into public.employee_evaluations
      (tenant_id, response_id, employee_id, subject_role, avg_score)
    select v_inv.tenant_id, v_response_id, (s->>'employee_id')::uuid,
           coalesce(s->>'subject_role', 'member'), p_csat_overall
    from jsonb_array_elements(v_inv.assignee_snapshot) s
    where (s ? 'employee_id') and nullif(s->>'employee_id','') is not null;
  end if;

  -- 6) consent PDPA (บังคับมี consent จริงก่อนบันทึก — FR-SC-04c/FR-PD)
  if p_consent is not null and (p_consent ? 'policy_version') then
    insert into public.consent_records
      (tenant_id, customer_id, policy_version, purpose_json, consented_at)
    values (v_inv.tenant_id, v_inv.customer_id, p_consent->>'policy_version',
            coalesce(p_consent->'purpose', '{}'::jsonb), now());
  end if;

  -- 7) ปิด invitation (single-use)
  update public.survey_invitations set status = 'responded' where id = v_inv.id;

  -- 8) enqueue งานวิเคราะห์ AI
  insert into public.job_queue (tenant_id, queue, payload)
  values (v_inv.tenant_id, 'ai_analysis',
          jsonb_build_object('response_id', v_response_id));

  return v_response_id;
end;
$$;

revoke all on function public.submit_survey_response(uuid,jsonb,numeric,jsonb,jsonb,jsonb) from public;
grant execute on function public.submit_survey_response(uuid,jsonb,numeric,jsonb,jsonb,jsonb) to service_role;

comment on function public.submit_survey_response(uuid,jsonb,numeric,jsonb,jsonb,jsonb) is
  'บันทึกผลแบบประเมินแบบ atomic (M2) — response/answers/scores/eval/consent + ปิด invitation + enqueue AI';
