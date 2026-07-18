-- =====================================================================
-- 0031 — chat_channels : mapping OA channel → tenant
--   รากฐานของโมดูล "AI วิเคราะห์แชท+ประเมินนักบัญชี" (Phase 0)
--
-- เป้าหมาย: เก็บ mapping ระหว่าง LINE OA channel (channel id / bot user id)
--   กับ tenant_id เพื่อให้ webhook route event ไปถูก tenant
--   (แก้ TODO ใน lib/line/webhook.ts resolveOaTenantId ที่ตอนนี้ใช้ "tenant แรก")
--
-- non-destructive: สร้างตารางใหม่ + enable RLS + policy + grant (ไม่แตะตารางเดิม)
-- ★ ยังไม่เก็บเนื้อหาแชต/ข้อความใด ๆ ในตารางนี้ — เป็นแค่ mapping ระดับ channel
-- =====================================================================

-- ---------------------------------------------------------------------
-- ตาราง chat_channels
--   provider     : ผู้ให้บริการแชต (เฟสนี้ = 'line')
--   channel_ref  : ตัวอ้างอิง channel ฝั่ง provider — สำหรับ LINE ใช้ค่า
--                  destination (bot user id) ที่มากับ webhook body หรือ channel id
--   oa_type      : ประเภท OA ('care'=ดูแลลูกค้า / 'sale'=ฝ่ายขาย / null=ไม่ระบุ)
-- ---------------------------------------------------------------------
create table if not exists public.chat_channels (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  provider     text not null default 'line',
  channel_ref  text not null,
  oa_type      text check (oa_type in ('care', 'sale')),
  display_name text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (provider, channel_ref)
);
create index if not exists idx_chat_channels_tenant on public.chat_channels(tenant_id);

-- updated_at อัตโนมัติ (ใช้ trigger function กลางจาก 0001)
create trigger trg_chat_channels_updated before update on public.chat_channels
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- RLS: tenant isolation ตาม pattern เดิม (0012) — ตารางใหม่ต้องมี ไม่งั้นรั่วข้าม tenant
--   (webhook อ่านผ่าน service_role ซึ่ง bypass RLS จึงยัง resolve ได้ปกติ)
-- ---------------------------------------------------------------------
alter table public.chat_channels enable row level security;
create policy tenant_isolation on public.chat_channels for all to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- ---------------------------------------------------------------------
-- GRANT: จัดสิทธิ์ระดับ Postgres ให้ตรงกับ posture เดิม (0013)
--   ตารางนี้สร้างหลัง 0013 จึงไม่ได้รับ grant เดิมอัตโนมัติ → ตั้งชัดเจน
--   - anon           : ปฏิเสธทั้งหมด (deny-by-default ตั้งแต่ชั้น GRANT)
--   - authenticated  : select/insert/update/delete (RLS คุม row ต่ออีกชั้น)
--   - service_role   : all (worker/webhook เบื้องหลัง)
-- ---------------------------------------------------------------------
revoke all on public.chat_channels from anon;
grant select, insert, update, delete on public.chat_channels to authenticated;
grant all on public.chat_channels to service_role;
