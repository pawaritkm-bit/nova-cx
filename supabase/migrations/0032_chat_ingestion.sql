-- =====================================================================
-- 0032 — Chat Ingestion (Phase 1) : เก็บแชตจากกลุ่ม LINE (เข้ารหัส at-rest)
--   ต่อจาก 0031 (chat_channels : mapping OA → tenant)
--
-- โมดูล "AI วิเคราะห์แชท+ประเมินนักบัญชี" — Phase 1 เก็บข้อมูลดิบเท่านั้น
--   (ยังไม่วิเคราะห์ AI — นั่น Phase 2)
--
-- ตารางใหม่ทั้งหมด:
--   chat_groups            — 1 แถวต่อ 1 กลุ่ม/ห้อง LINE
--   chat_members           — สมาชิกในกลุ่ม (line_user → best-effort ระบุตัวตน)
--   chat_messages          — ข้อความ (content_enc = ciphertext, idempotent)
--   message_attachments    — metadata ไฟล์แนบ (ยังไม่ดาวน์โหลด binary จริง)
--   customer_group_mapping — audit log การจับคู่ กลุ่ม ↔ ลูกค้า (append-only)
--
-- non-destructive: สร้างตารางใหม่ล้วน + enable RLS + tenant_isolation (0012)
--   + grant posture (revoke anon / CRUD authenticated / all service_role — 0013)
--   ไม่แตะตารางเดิม / ไม่แตะ pseudonymity (0025/0027) / ไม่แตะ AI
--
-- ★ เนื้อหาแชต (chat_messages.content_enc) เก็บเป็น ciphertext เท่านั้น
--   เข้ารหัสระดับแอปด้วย CREDENTIAL_ENC_KEY (lib/crypto/field.ts) ห้ามเก็บ plain text
--
-- decision (กัน redundant):
--   chat_groups.customer_id = "source of truth" ของการจับคู่ปัจจุบัน (1 กลุ่ม→1 ลูกค้า)
--   customer_group_mapping  = "audit/history" ของการจับคู่แต่ละครั้ง (append-only, ไม่ unique)
--   → ไม่เก็บข้อมูลจับคู่ซ้ำซ้อนแบบ 1:1 ในสองที่
-- =====================================================================

-- ---------------------------------------------------------------------
-- chat_groups — 1 แถวต่อ 1 กลุ่ม/ห้อง LINE
--   group_ref     : LINE groupId (หรือ roomId) — unique ต่อ provider (LINE ออก id ไม่ซ้ำทั้งระบบ)
--   group_kind    : 'group' (กลุ่ม) / 'room' (ห้องหลายคนแบบชั่วคราว)
--   chat_channel_id : OA channel ที่กลุ่มนี้เข้ามา (best-effort → nullable ถ้า resolve ไม่เจอ)
--   customer_id   : ลูกค้าที่ผูกกับกลุ่ม (nullable — จับคู่ภายหลังโดยแอดมิน) = source of truth
-- ---------------------------------------------------------------------
create table if not exists public.chat_groups (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  chat_channel_id uuid references public.chat_channels(id) on delete set null,
  customer_id     uuid references public.customers(id) on delete set null,
  provider        text not null default 'line',
  group_ref       text not null,
  group_kind      text not null default 'group' check (group_kind in ('group', 'room')),
  display_name    text,
  joined_at       timestamptz,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (provider, group_ref)
);
create index if not exists idx_chat_groups_tenant on public.chat_groups(tenant_id);
create index if not exists idx_chat_groups_customer on public.chat_groups(customer_id);
create index if not exists idx_chat_groups_channel on public.chat_groups(chat_channel_id);

create trigger trg_chat_groups_updated before update on public.chat_groups
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- chat_members — สมาชิกในกลุ่ม
--   line_user_id    : source.userId ของ LINE (อาจไม่ได้ครบทุกคนถ้าไม่ยินยอม)
--   display_name_enc: ★ ciphertext ของชื่อที่แสดง (PDPA — ชื่อคนเป็น PII) ห้ามเก็บ plain
--   member_kind     : ประเภทสมาชิก — default 'unknown' (LINE ไม่บอกว่าใครเป็นใคร)
--   employee_id     : ผูกกับพนักงาน (nullable — ต้องมี flow ลงทะเบียนใน Phase หลัง)
--   line_user_ref   : ผูกกับ line_users (บัญชี LINE ลูกค้าที่รู้จักแล้ว) nullable
--   customer_contact_id : ผูกกับผู้ติดต่อของลูกค้า nullable
-- ---------------------------------------------------------------------
create table if not exists public.chat_members (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  chat_group_id       uuid not null references public.chat_groups(id) on delete cascade,
  line_user_id        text not null,
  display_name_enc    text,
  member_kind         text not null default 'unknown'
                        check (member_kind in ('customer', 'accountant', 'lead', 'system', 'unknown')),
  employee_id         uuid references public.employees(id) on delete set null,
  line_user_ref       uuid references public.line_users(id) on delete set null,
  customer_contact_id uuid references public.customer_contacts(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (chat_group_id, line_user_id)
);
create index if not exists idx_chat_members_tenant on public.chat_members(tenant_id);
create index if not exists idx_chat_members_group on public.chat_members(chat_group_id);
create index if not exists idx_chat_members_employee on public.chat_members(employee_id);

create trigger trg_chat_members_updated before update on public.chat_members
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- chat_messages ★ — ข้อความในกลุ่ม
--   line_message_id : id ข้อความจาก LINE — unique (idempotency กัน webhook ส่งซ้ำ)
--   content_enc     : ciphertext ของข้อความ text (nullable ถ้าไม่ใช่ text)
--   sent_at         : เวลาจาก event.timestamp (ไม่ใช่เวลา insert)
--   raw_meta        : metadata ที่ไม่มี PII ดิบ (source type, group_ref, ฯลฯ)
-- append-only โดยเจตนา — ไม่ควร UPDATE/DELETE เนื้อหา (soft delete ผ่าน deleted_at)
-- ---------------------------------------------------------------------
create table if not exists public.chat_messages (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  chat_group_id        uuid not null references public.chat_groups(id) on delete cascade,
  line_message_id      text not null,
  sender_line_user_id  text,
  chat_member_id       uuid references public.chat_members(id) on delete set null,
  message_type         text not null default 'text',
  content_enc          text,
  sent_at              timestamptz,
  raw_meta             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (line_message_id)
);
create index if not exists idx_chat_messages_tenant on public.chat_messages(tenant_id);
create index if not exists idx_chat_messages_group_sent on public.chat_messages(chat_group_id, sent_at);

create trigger trg_chat_messages_updated before update on public.chat_messages
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- message_attachments — metadata ไฟล์แนบ (Phase 1 ยังไม่ดาวน์โหลด binary)
--   line_content_id : id เนื้อหาฝั่ง LINE (= message.id) ไว้ดึง binary ทีหลัง
--   status          : 'pending' (ยังไม่ดึง) → future: 'stored' / 'failed'
--   storage_path    : path ใน storage เมื่อดึงมาเก็บแล้ว (nullable ตอนนี้)
-- ---------------------------------------------------------------------
create table if not exists public.message_attachments (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  chat_message_id  uuid not null references public.chat_messages(id) on delete cascade,
  attachment_type  text not null,
  line_content_id  text,
  status           text not null default 'pending' check (status in ('pending', 'stored', 'failed', 'skipped')),
  storage_path     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  -- idempotent: 1 message + 1 content_id = 1 attachment (กัน re-ingest สร้างซ้ำ)
  unique (chat_message_id, line_content_id)
);
create index if not exists idx_message_attachments_tenant on public.message_attachments(tenant_id);
create index if not exists idx_message_attachments_message on public.message_attachments(chat_message_id);

create trigger trg_message_attachments_updated before update on public.message_attachments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- customer_group_mapping — audit/history การจับคู่ กลุ่ม ↔ ลูกค้า (append-only)
--   ไม่มี unique(chat_group_id) โดยเจตนา — เก็บได้หลายรายการตามประวัติการจับคู่
--   "การจับคู่ปัจจุบัน" อ่านจาก chat_groups.customer_id (source of truth)
--   mapped_by : id ผู้ทำรายการ (app user/employee) — เก็บเป็น uuid audit ไม่ FK แข็ง
-- ---------------------------------------------------------------------
create table if not exists public.customer_group_mapping (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  chat_group_id  uuid not null references public.chat_groups(id) on delete cascade,
  customer_id    uuid not null references public.customers(id) on delete cascade,
  mapped_by      uuid,
  mapped_at      timestamptz not null default now(),
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_customer_group_mapping_tenant on public.customer_group_mapping(tenant_id);
create index if not exists idx_customer_group_mapping_group on public.customer_group_mapping(chat_group_id);
create index if not exists idx_customer_group_mapping_customer on public.customer_group_mapping(customer_id);

-- =====================================================================
-- RLS: tenant isolation (pattern 0012) — ตารางใหม่ทุกตัวต้องมี
--   worker/webhook อ่าน-เขียนผ่าน service_role (bypass RLS) จึงทำงานได้ปกติ
-- =====================================================================
alter table public.chat_groups            enable row level security;
alter table public.chat_members           enable row level security;
alter table public.chat_messages          enable row level security;
alter table public.message_attachments    enable row level security;
alter table public.customer_group_mapping enable row level security;

create policy tenant_isolation on public.chat_groups for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_isolation on public.chat_members for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_isolation on public.chat_messages for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_isolation on public.message_attachments for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_isolation on public.customer_group_mapping for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- =====================================================================
-- GRANT posture (pattern 0013) — ตารางสร้างหลัง 0013 จึงต้องตั้งชัดเจน
--   anon           : ปฏิเสธทั้งหมด (deny-by-default ตั้งแต่ชั้น GRANT)
--   authenticated  : select/insert/update/delete (RLS คุม row อีกชั้น)
--   service_role   : all (worker/webhook เบื้องหลัง)
-- =====================================================================
revoke all on public.chat_groups            from anon;
revoke all on public.chat_members           from anon;
revoke all on public.chat_messages          from anon;
revoke all on public.message_attachments    from anon;
revoke all on public.customer_group_mapping from anon;

grant select, insert, update, delete on public.chat_groups            to authenticated;
grant select, insert, update, delete on public.chat_members           to authenticated;
grant select, insert, update, delete on public.chat_messages          to authenticated;
grant select, insert, update, delete on public.message_attachments    to authenticated;
grant select, insert, update, delete on public.customer_group_mapping to authenticated;

grant all on public.chat_groups            to service_role;
grant all on public.chat_members           to service_role;
grant all on public.chat_messages          to service_role;
grant all on public.message_attachments    to service_role;
grant all on public.customer_group_mapping to service_role;
