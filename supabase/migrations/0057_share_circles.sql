-- =====================================================================
-- 0057 — วงแชร์ (share_circles + share_circle_hands)
-- =====================================================================
-- บริบท: ลูกค้าที่เป็น "ท้าวแชร์" ส่งลิสต์วงแชร์เข้ากลุ่มไลน์ (คำพิม + รูป)
--   นักบัญชีต้องเอาไปคิด "รายได้จากวงแชร์" เพื่อยื่นภาษี (ภธ.40 ทุกเดือน + ภงด.90 ปลายปี)
--
--   share_circles      : 1 แถว = 1 วง (ต้น/จำนวนมือ/ค่าดูแล/รอบ) ของลูกค้า(ท้าว) 1 ราย
--   share_circle_hands : 1 แถว = 1 มือ (สมาชิก) ในวง — ยอดส่ง + ดอก(เปีย) + เป็นท้าวไหม
--
--   ★ tenant-scoped + RLS (pattern 0054): authenticated อ่านอย่างเดียว,
--     write ผ่าน service_role (server action ที่ guard admin + customer scope).
--   ★ soft-delete (deleted_at) — ไม่ลบจริง.
--   ★ ไม่มีกฎเพดานดอกเบี้ย 15% (แชร์ไม่ใช่เงินกู้) — คิดรายได้ตามจริง/ตาม Excel
--
-- non-destructive: สร้าง 2 ตารางใหม่ ไม่แตะตาราง/flow เดิม
-- =====================================================================

-- ---- วง ----
create table if not exists public.share_circles (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id)   on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  name          text not null,
  principal     numeric(16,2),          -- ต้น (เงินต้น/มือ)
  num_hands     integer,                -- จำนวนมือ
  fee_per_hand  numeric(16,2),          -- ค่าดูแล/มือ
  period_note   text,                   -- รอบ (เช่น "รายเดือน ทุกวันที่ 15")
  start_date    date,                   -- วันเริ่มวง
  source_text   text,                   -- ข้อความต้นฉบับจากไลน์ (เก็บไว้อ้างอิง/สกัดซ้ำ)
  status        text not null default 'active',  -- active | closed
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index if not exists idx_share_circles_tenant_customer
  on public.share_circles (tenant_id, customer_id)
  where deleted_at is null;

create trigger trg_share_circles_updated before update on public.share_circles
  for each row execute function public.set_updated_at();

-- ---- มือ (สมาชิกในวง) ----
create table if not exists public.share_circle_hands (
  id            uuid primary key default gen_random_uuid(),
  circle_id     uuid not null references public.share_circles(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  hand_no       integer,                -- ลำดับมือ
  member_name   text,                   -- ชื่อสมาชิก
  send_amount   numeric(16,2),          -- ยอดส่ง/งวด
  bid_amount    numeric(16,2),          -- ดอก (เปีย)
  is_organizer  boolean not null default false,  -- เป็นท้าว (เจ้าของวง)
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index if not exists idx_share_circle_hands_circle
  on public.share_circle_hands (circle_id, hand_no)
  where deleted_at is null;

create trigger trg_share_circle_hands_updated before update on public.share_circle_hands
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS: tenant isolation (pattern 0054)
--   authenticated : SELECT เท่านั้น — write ผ่าน service_role (server action guard admin)
--   service_role  : all
-- =====================================================================
alter table public.share_circles      enable row level security;
alter table public.share_circle_hands enable row level security;

create policy tenant_read on public.share_circles for select to authenticated
  using (tenant_id = public.current_tenant_id());
create policy tenant_read on public.share_circle_hands for select to authenticated
  using (tenant_id = public.current_tenant_id());

revoke all on public.share_circles      from anon;
revoke all on public.share_circle_hands from anon;
grant select on public.share_circles      to authenticated;
grant select on public.share_circle_hands to authenticated;
grant all    on public.share_circles      to service_role;
grant all    on public.share_circle_hands to service_role;

-- reload PostgREST schema cache (ตารางใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
