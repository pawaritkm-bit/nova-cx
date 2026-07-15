-- =====================================================================
-- 0026 — Atomic scheduled invitation RPC (chunk 4 / Reviewer 🔴H2)
--   scan สร้าง survey_invitation + enqueue job_queue(notification)
--   "ใน transaction เดียว" → ถ้า enqueue ล้ม invitation จะ rollback ด้วย
--   (กันเคส invitation ค้างแต่ job หาย → รอบหน้า existed → ลูกค้าไม่ได้รับ)
--
--   idempotent: on conflict (tenant_id, idempotency_key) → คืน created=false
--   ไม่ enqueue ซ้ำ (สอดคล้อง FR-SC-05 ประเมิน 1 ครั้ง/รอบ)
--
--   SECURITY DEFINER + fixed search_path; execute เฉพาะ service_role
-- ตาราง survey_invitations / job_queue มีอยู่แล้ว (0006/0009) — migration นี้
-- เพิ่มเฉพาะฟังก์ชัน ไม่แก้โครงเดิม
-- =====================================================================

create or replace function public.create_scheduled_invitation(
  p_tenant_id          uuid,
  p_customer_id        uuid,
  p_line_user_id       uuid,        -- null สำหรับ A (ส่งเข้ากลุ่ม ไม่ผูกบุคคล)
  p_survey_type        text,        -- 'A' | 'B'
  p_survey_version_id  uuid,
  p_cycle_period       text,
  p_assignee_snapshot  jsonb,       -- [] สำหรับ A
  p_token              text,
  p_token_expires_at   timestamptz,
  p_idempotency_key    text,
  p_oa                 text         -- 'care' | 'sale' (payload notification)
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  -- 1) insert invitation (idempotent) — ชน unique(tenant_id, idempotency_key) → ไม่ทำอะไร
  insert into public.survey_invitations (
    tenant_id, customer_id, line_user_id, survey_type, survey_version_id,
    cycle_period, assignee_snapshot, token, token_expires_at, status, idempotency_key
  ) values (
    p_tenant_id, p_customer_id, p_line_user_id, p_survey_type, p_survey_version_id,
    p_cycle_period, coalesce(p_assignee_snapshot, '[]'::jsonb), p_token,
    p_token_expires_at, 'pending', p_idempotency_key
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_id;

  -- 2) มีอยู่แล้ว (v_id null = on conflict do nothing) → คืน existed ไม่ enqueue ซ้ำ
  if v_id is null then
    select id into v_id
    from public.survey_invitations
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    return jsonb_build_object('invitation_id', v_id, 'created', false);
  end if;

  -- 3) enqueue notification job — อยู่ transaction เดียวกับ insert → atomic
  --    (ถ้าบรรทัดนี้ล้ม ทั้ง insert ข้างบนถูก rollback ไปด้วย)
  insert into public.job_queue (tenant_id, queue, payload)
  values (
    p_tenant_id,
    'notification',
    jsonb_build_object(
      'kind', 'survey_invitation',
      'invitation_id', v_id,
      'survey_type', p_survey_type,
      'oa', p_oa
    )
  );

  return jsonb_build_object('invitation_id', v_id, 'created', true);
end;
$$;

revoke all on function public.create_scheduled_invitation(
  uuid, uuid, uuid, text, uuid, text, jsonb, text, timestamptz, text, text
) from public;
grant execute on function public.create_scheduled_invitation(
  uuid, uuid, uuid, text, uuid, text, jsonb, text, timestamptz, text, text
) to service_role;

comment on function public.create_scheduled_invitation(
  uuid, uuid, uuid, text, uuid, text, jsonb, text, timestamptz, text, text
) is
  'สร้าง survey_invitation + enqueue notification job แบบ atomic (chunk 4 H2) — idempotent on (tenant_id, idempotency_key)';
