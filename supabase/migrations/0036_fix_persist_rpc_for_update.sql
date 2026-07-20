-- =====================================================================
-- 0036_fix_persist_rpc_for_update.sql
-- -----------------------------------------------------------------------
-- Hotfix บั๊ก prod: job chat_analysis fail ที่ persist_failed ด้วย
--   Postgres error 0A000 (feature_not_supported)
--
-- สาเหตุ: RPC persist_chat_analysis (migration 0033) ใช้ idempotency guard
--   แบบ `SELECT count(*) ... FOR UPDATE` ซึ่ง Postgres ห้าม — FOR UPDATE
--   ใช้ร่วมกับ aggregate function (count/sum/...) / GROUP BY / DISTINCT
--   ไม่ได้ → RPC ระเบิดตอนรันจริง (unit test ที่ mock DB จับไม่ได้)
--
-- การแก้: ล็อกแถวก่อนด้วย CTE `... FOR UPDATE` (เป็น plain SELECT ไม่มี
--   aggregate ที่ระดับเดียวกัน) แล้วค่อย count จาก CTE ที่ล็อกแล้วในชั้นนอก
--   → คงพฤติกรรม idempotent + atomic เดิมไว้ทุกประการ
--
-- ขอบเขต: ตรวจทุก RPC ในทุก migration ที่ใช้ FOR UPDATE แล้ว —
--   มีแค่ persist_chat_analysis (0033) เท่านั้นที่ใช้ aggregate + FOR UPDATE
--   ตัวอื่น (0020/0034/0035) เป็น `SELECT <columns> [LIMIT 1] FOR UPDATE`
--   ไม่มี aggregate/GROUP BY/DISTINCT จึงถูกต้องตามกติกา Postgres อยู่แล้ว
--
-- Non-destructive: CREATE OR REPLACE function อย่างเดียว ไม่แตะข้อมูล/สคีมา
-- Idempotent: รันซ้ำได้ปลอดภัย (replace ทับตัวเดิม)
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
  --
  --   FIX 0A000: เดิมใช้ `SELECT count(*) ... FOR UPDATE` (Postgres ห้าม aggregate+FOR UPDATE)
  --   แก้เป็น CTE ล็อกแถว (plain SELECT + FOR UPDATE) แล้ว count จาก CTE ในชั้นนอก
  --   → ยัง atomic เดิม: แถวถูกล็อกใน statement เดียวกันกับที่นับ
  if v_count > 0 then
    with locked as (
      select id
      from public.chat_messages
      where tenant_id = p_tenant_id
        and chat_group_id = p_chat_group_id
        and analyzed_at is null
        and id in (select (jsonb_array_elements_text(p_message_ids))::uuid)
      for update
    )
    select count(*) into v_unanalyzed from locked;

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
  'บันทึกผลวิเคราะห์บทสนทนา 1 window (ai_chat_analysis + customer_sentiment + sop_violations) + mark analyzed แบบ atomic (Phase 2). 0036: แก้ idempotency guard ที่ใช้ count()+FOR UPDATE (error 0A000) เป็น CTE lock-then-count';
