-- =====================================================================
-- 0041 — Reply Knowledge Base : คลังคำตอบ "คู่ถาม-ตอบ" ของทีม (Phase 1)
--
-- เป้าหมาย: สกัด "คู่ถาม-ตอบ" (ลูกค้าถาม → พนักงานตอบ) จากแชต "กลุ่ม" ที่เก็บไว้
--   → คลังความรู้จัดหมวด ให้แอดมินรีวิว/คัดกรอง เป็นฐานให้ AI ในอนาคต
--   ★ เฟสนี้ "เก็บ+เรียนรู้เท่านั้น" — AI ยังไม่ตอบลูกค้า/ไม่ร่างคำตอบ
--
-- ข้อจำกัด/หลักการ (สำคัญ):
--   - เรียนจาก "แชตกลุ่ม" เท่านั้น (chat_groups.group_kind ∈ 'group','room')
--     ★ ห้ามแตะบทสนทนา 1-1 (group_kind='user') ของโมดูล office
--   - PDPA: gist ที่เก็บต้อง redact PII ก่อนส่ง AI + เข้ารหัส at-rest (question_gist_enc/answer_gist_enc)
--   - แยกจากระบบประเมินนักบัญชี/office เด็ดขาด — ตาราง/RPC/queue ใหม่ ไม่แตะของเดิม
--
-- decision (กันปนเปื้อน + idempotency ที่ไม่ชนกับ chat analysis เดิม):
--   - chat analysis เดิม (per-accountant) ใช้ chat_messages.analyzed_at เป็น marker
--     ถ้า knowledge worker reuse analyzed_at จะแย่งกัน (ใครมาก่อน mark ก่อน อีกฝั่งเห็น window ว่าง)
--     → เพิ่มคอลัมน์แยก chat_messages.knowledge_extracted_at (additive, nullable)
--       ให้ pipeline สกัดความรู้เดินอิสระจากการวิเคราะห์ประเมิน (ไม่กระทบของเดิม)
--   - ผลเก็บใน "ตารางแยก" reply_knowledge (ไม่ผสม ai_chat_analysis/office_inbound_analysis)
--   - queue ใหม่ 'knowledge_extract' + partial unique index กัน job ซ้อนต่อกลุ่ม
--   - RPC persist_reply_knowledge() insert หลายแถว (คู่ Q&A ต่อ window) + mark idempotency
--       ★ ใช้ CTE lock-then-count ห้าม count(*) + FOR UPDATE (บทเรียน 0A000)
-- =====================================================================

-- ---------------------------------------------------------------------
-- chat_messages: knowledge_extracted_at — เวลาที่ข้อความถูกรวมเข้ารอบ "สกัดความรู้" แล้ว
--   null = ยังไม่สกัด (knowledge scan จะหยิบไปทำ window ถัดไป)
--   ★ additive: คอลัมน์ใหม่ nullable ไม่กระทบ ingest/chat analysis เดิม (คนละ marker กับ analyzed_at)
-- ---------------------------------------------------------------------
alter table public.chat_messages
  add column if not exists knowledge_extracted_at timestamptz;

-- ดัชนีบางส่วน: เร่ง scan หากลุ่มที่ยังมีข้อความค้าง "สกัดความรู้"
create index if not exists idx_chat_messages_unextracted
  on public.chat_messages(chat_group_id, sent_at)
  where knowledge_extracted_at is null and deleted_at is null;

-- ---------------------------------------------------------------------
-- job_queue.queue : เพิ่มค่า 'knowledge_extract' (คงค่าเดิมครบจาก 0040)
--   ค่าเดิม (ถึง 0040): notification/ai_analysis/line_event/chat_analysis/
--                       case_notification/evaluation/office_inbound
-- ---------------------------------------------------------------------
alter table public.job_queue drop constraint if exists job_queue_queue_check;
alter table public.job_queue add constraint job_queue_queue_check
  check (queue in ('notification','ai_analysis','line_event','chat_analysis',
                   'case_notification','evaluation','office_inbound','knowledge_extract'));

-- ★ กัน job knowledge_extract ซ้อนต่อกลุ่ม (cron overlap/reclaim) ตั้งแต่ชั้น DB
--   อนุญาต pending/processing ได้แค่ 1 งานต่อ chat_group_id — knowledge scan จับ 23505 → skip
create unique index if not exists uq_job_queue_knowledge_extract_active
  on public.job_queue ((payload->>'chat_group_id'))
  where queue = 'knowledge_extract' and status in ('pending','processing');

-- ---------------------------------------------------------------------
-- reply_knowledge — คลังคู่ถาม-ตอบที่สกัดจากแชตกลุ่ม (1 แถว = 1 คู่ Q&A)
--   category          : หมวด (AI จัดเอง เป็นภาษาไทย open set เช่น ภาษี/เอกสาร/ชำระเงิน/นัดหมาย/ทั่วไป)
--   question_gist_enc : คำถามลูกค้าแบบสรุป/ลบ PII แล้ว — ciphertext (PDPA)
--   answer_gist_enc   : แนวคำตอบของทีมแบบสรุป/ลบ PII แล้ว (แพตเทิร์น ไม่ใช่ข้อมูลเฉพาะลูกค้า) — ciphertext
--   staff_employee_id : พนักงานที่ตอบ (nullable — resolve จากข้อความคำตอบใน window)
--   staff_role        : บทบาทผู้ตอบ (member_kind: accountant/lead/... nullable)
--   status            : new (รอรีวิว) → approved | rejected (แอดมินคัดกรอง)
--   blocked_reason    : marker เมื่อ window ถูกบล็อก (residual PII หลุด redact) — ไม่ส่ง AI
--   validated         : true เมื่อ AI ผลิต JSON ตาม schema สำเร็จ (worker เป็นผู้ตัดสิน)
-- ---------------------------------------------------------------------
create table if not exists public.reply_knowledge (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  chat_group_id      uuid not null references public.chat_groups(id) on delete cascade,
  source_message_ids jsonb not null default '[]'::jsonb,
  category           text,
  question_gist_enc  text,
  answer_gist_enc    text,
  staff_employee_id  uuid references public.employees(id) on delete set null,
  staff_role         text,
  confidence         numeric(4,3),
  status             text not null default 'new' check (status in ('new','approved','rejected')),
  model              text,
  provider           text,
  blocked_reason     text,
  validated          boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index if not exists idx_reply_knowledge_tenant   on public.reply_knowledge(tenant_id);
create index if not exists idx_reply_knowledge_group     on public.reply_knowledge(chat_group_id, created_at);
create index if not exists idx_reply_knowledge_category  on public.reply_knowledge(category);
create index if not exists idx_reply_knowledge_status    on public.reply_knowledge(status);

create trigger trg_reply_knowledge_updated before update on public.reply_knowledge
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS: tenant isolation (pattern 0012) — ตารางใหม่ต้องมี
--   worker เขียนผ่าน service_role (bypass RLS) จึงทำงานได้ปกติ
-- =====================================================================
alter table public.reply_knowledge enable row level security;

create policy tenant_isolation on public.reply_knowledge for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- =====================================================================
-- GRANT posture (pattern 0013/0040) — ตารางสร้างหลัง 0013 ต้องตั้งชัดเจน
--   anon          : ปฏิเสธทั้งหมด (deny-by-default)
--   authenticated : SELECT + UPDATE (แอดมินอนุมัติ/ตัดออก = อัปเดต status ผ่าน server action)
--                   ★ INSERT/DELETE ไม่ให้ — เขียนคู่ Q&A ผ่าน service_role/RPC (worker) เท่านั้น
--   service_role  : all (worker เบื้องหลัง)
-- =====================================================================
revoke all    on public.reply_knowledge from anon;
grant select, update on public.reply_knowledge to authenticated;
grant all     on public.reply_knowledge to service_role;

-- =====================================================================
-- persist_reply_knowledge() — บันทึกคู่ Q&A ที่สกัดได้ต่อ 1 window แบบ atomic
--   1) ยืนยัน chat_group อยู่ใน tenant + group_kind ∈ ('group','room')
--      ★ กันเขียนความรู้จากบทสนทนา 1-1 (group_kind='user') โดยไม่ตั้งใจ
--   2) idempotency guard: ล็อกข้อความใน window ที่ยัง knowledge_extracted_at IS NULL
--      ★ ใช้ CTE lock-then-count — ห้าม count(*) + FOR UPDATE (บทเรียน 0A000)
--      ถ้า 0 = window นี้ถูกสกัดไปแล้ว → no-op (ไม่ insert ซ้ำ/ไม่จ่าย AI ซ้ำ)
--   3) insert reply_knowledge หลายแถว จาก p_items (0..N คู่)
--   4) mark chat_messages.knowledge_extracted_at ของ message ids ใน window
--   SECURITY DEFINER + fixed search_path; execute เฉพาะ service_role (worker)
-- =====================================================================
create or replace function public.persist_reply_knowledge(
  p_tenant_id      uuid,
  p_chat_group_id  uuid,
  p_message_ids    jsonb,   -- array ของ message uuid (string) — window ที่สกัด
  p_items          jsonb    -- array ของ {category, question_gist_enc, answer_gist_enc,
                            --            staff_employee_id, staff_role, confidence,
                            --            model, provider, blocked_reason, validated}
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count       integer;
  v_unextracted integer := 0;
  v_inserted    integer := 0;
  v_marked      integer := 0;
begin
  -- 1) ยืนยันกลุ่มอยู่ใน tenant นี้ + เป็นแชต "กลุ่ม" (group/room) เท่านั้น
  --    ★ กันเขียนความรู้จากบทสนทนา 1-1 (group_kind='user') ของ office
  perform 1 from public.chat_groups
  where id = p_chat_group_id and tenant_id = p_tenant_id
    and group_kind in ('group','room');
  if not found then
    raise exception 'knowledge_group_not_found_or_not_group_chat' using errcode = 'P0002';
  end if;

  v_count := coalesce(jsonb_array_length(p_message_ids), 0);

  -- 2) idempotency guard: นับเฉพาะข้อความที่ยัง knowledge_extracted_at IS NULL (ล็อกก่อน count)
  --    ★ CTE lock-then-count — กัน 0A000 "FOR UPDATE with aggregate"
  if v_count > 0 then
    with locked as (
      select id
      from public.chat_messages
      where tenant_id = p_tenant_id
        and chat_group_id = p_chat_group_id
        and knowledge_extracted_at is null
        and id in (select (jsonb_array_elements_text(p_message_ids))::uuid)
      for update
    )
    select count(*) into v_unextracted from locked;

    if v_unextracted = 0 then
      return jsonb_build_object(
        'inserted', 0,
        'message_count', v_count,
        'marked_extracted', 0,
        'noop', true
      );
    end if;
  end if;

  -- 3) insert คู่ Q&A (0..N) — source_message_ids = window เดียวกันทุกแถว
  if coalesce(jsonb_array_length(p_items), 0) > 0 then
    insert into public.reply_knowledge (
      tenant_id, chat_group_id, source_message_ids, category,
      question_gist_enc, answer_gist_enc, staff_employee_id, staff_role,
      confidence, model, provider, blocked_reason, validated
    )
    select
      p_tenant_id,
      p_chat_group_id,
      coalesce(p_message_ids, '[]'::jsonb),
      nullif(e->>'category',''),
      nullif(e->>'question_gist_enc',''),
      nullif(e->>'answer_gist_enc',''),
      nullif(e->>'staff_employee_id','')::uuid,
      nullif(e->>'staff_role',''),
      nullif(e->>'confidence','')::numeric,
      nullif(e->>'model',''),
      nullif(e->>'provider',''),
      nullif(e->>'blocked_reason',''),
      coalesce((e->>'validated')::boolean, false)
    from jsonb_array_elements(p_items) as e;
    get diagnostics v_inserted = row_count;
  end if;

  -- 4) mark ข้อความใน window ว่าสกัดความรู้แล้ว (idempotency กันสกัดซ้ำ)
  if v_count > 0 then
    update public.chat_messages
    set knowledge_extracted_at = now()
    where tenant_id = p_tenant_id
      and chat_group_id = p_chat_group_id
      and knowledge_extracted_at is null
      and id in (select (jsonb_array_elements_text(p_message_ids))::uuid);
    get diagnostics v_marked = row_count;
  end if;

  return jsonb_build_object(
    'inserted', v_inserted,
    'message_count', v_count,
    'marked_extracted', v_marked
  );
end;
$$;

revoke all on function public.persist_reply_knowledge(uuid,uuid,jsonb,jsonb) from public;
grant execute on function public.persist_reply_knowledge(uuid,uuid,jsonb,jsonb) to service_role;

comment on function public.persist_reply_knowledge(uuid,uuid,jsonb,jsonb) is
  'บันทึกคู่ถาม-ตอบที่สกัดจากแชตกลุ่ม 1 window (reply_knowledge) + mark knowledge_extracted_at แบบ atomic (Phase 1)';

-- ให้ PostgREST รีโหลด schema cache (ตารางใหม่/คอลัมน์ใหม่/RPC ใหม่จะเห็นทันที)
notify pgrst, 'reload schema';
