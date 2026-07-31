-- =====================================================================
-- 0046 — ลงบันทึกบัญชี ภาษีซื้อ/ขาย (bill_entries + bill_entry_lines)
-- =====================================================================
-- บริบท (เฟสต่อจาก 0043/0044/0045 ฝั่ง CX เก็บบิลจาก LINE):
--   pipeline เดิม (0043-0045) ดึงบิลจาก LINE → เก็บขึ้น Supabase Storage bucket `bills`
--   (message_attachments: fetch_status='stored', doc_kind=slip/sale/purchase/...).
--   เฟสนี้เพิ่มชั้น "ลงบันทึกบัญชี": AI สกัดข้อมูลบิล → draft ให้คนตรวจ/แก้ →
--   ยืนยัน → export Excel (ภาษีซื้อ/ภาษีขาย).
--
--   โครง 2 ตาราง:
--     bill_entries      : 1 แถว = 1 เอกสาร/บิล (หัวเอกสาร)
--     bill_entry_lines  : บรรทัดรายการ (รองรับบิลผสม VAT + ไม่ VAT ในใบเดียว)
--
--   ★ high-confidence only: AI เว้นช่องที่ไม่มั่นใจเป็น null ให้คนคีย์
--     (ค่าตัวเลขผิด = ยื่นภาษีผิด) — บังคับใน lib/ai/bill-extract.ts
--   ★ ทุกอย่าง tenant-scoped + RLS (current_tenant_id ตาม pattern 0011/0012/0035)
--   ★ write เฉพาะ service_role (worker/server-action ที่ guard admin) — authenticated อ่านอย่างเดียว
--
-- non-destructive: สร้างตารางใหม่ 2 ตัวเท่านั้น ไม่แตะตาราง/flow เดิม
-- =====================================================================

-- ---------------------------------------------------------------------
-- bill_entries — หัวเอกสาร (1 แถว = 1 บิล/ใบกำกับ)
--   attachment_id : บิลต้นทางใน message_attachments (null = คีย์เอง ไม่มีไฟล์)
--   customer_id   : ลูกค้าเจ้าของบิล (จับคู่จาก chat_group ตอน AI สกัด · null ได้)
--   entry_type    : purchase (ภาษีซื้อ) | sale (ภาษีขาย) | unspecified (รอระบุ)
--     ★ บิลใบเดียวเป็น "ขาย" ของผู้ขาย / "ซื้อ" ของผู้ซื้อ — ขึ้นกับว่าลูกค้าเราอยู่ฝั่งไหน
--     AI ไม่ตัดสินเอง (เดาผิดง่าย) → worker จับคู่ลูกค้าเรากับ seller/buyer ที่ AI อ่าน
--     จับคู่ไม่ชัด/ไม่มีข้อมูลลูกค้า = 'unspecified' (ให้คนเลือกซื้อ/ขายในหน้า UI)
--   counterparty_* : คู่ค้า = "อีกฝั่ง" ที่ไม่ใช่ลูกค้าเรา (resolve แล้ว · unspecified = null)
--   seller_*/buyer_* : ★ ชื่อ+เลขภาษีที่ AI อ่านได้ของ "ผู้ขาย" และ "ผู้ซื้อ" (raw)
--     เก็บทั้ง 2 ฝั่งไว้ให้ UI โชว์ตอน 'unspecified' เพื่อให้คนเลือกว่าเราคือฝั่งไหน
--   wht_form      : แบบยื่นหัก ณ ที่จ่าย (pnd3 บุคคล / pnd53 นิติบุคคล / null=ไม่มี)
--   status        : draft (ร่าง แก้ได้) | confirmed (ยืนยันแล้ว เข้ารายงาน)
--   source        : ai (AI สกัด) | manual (คนคีย์เอง)
--   ai_confidence : ความมั่นใจรวมของ AI 0..1 (null = คีย์เอง)
-- ---------------------------------------------------------------------
create table if not exists public.bill_entries (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  attachment_id       uuid references public.message_attachments(id) on delete set null,
  customer_id         uuid references public.customers(id) on delete set null,
  entry_type          text not null default 'unspecified'
                        check (entry_type in ('purchase','sale','unspecified')),
  doc_date            date,
  doc_no              text,
  counterparty_name   text,
  counterparty_tax_id text,
  seller_name         text,
  seller_tax_id       text,
  buyer_name          text,
  buyer_tax_id        text,
  wht_form            text check (wht_form in ('pnd3','pnd53') or wht_form is null),
  status              text not null default 'draft'  check (status in ('draft','confirmed')),
  source              text not null default 'ai'     check (source in ('ai','manual')),
  ai_confidence       real,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  confirmed_at        timestamptz,
  deleted_at          timestamptz
);

-- index สำหรับ cron หา attachment ที่ยังไม่มี entry (left join) + list ตาม tenant/type
create index if not exists idx_bill_entries_tenant_type
  on public.bill_entries (tenant_id, entry_type)
  where deleted_at is null;
create index if not exists idx_bill_entries_attachment
  on public.bill_entries (attachment_id)
  where attachment_id is not null;
create index if not exists idx_bill_entries_customer
  on public.bill_entries (tenant_id, customer_id)
  where deleted_at is null;
create index if not exists idx_bill_entries_doc_date
  on public.bill_entries (tenant_id, doc_date)
  where deleted_at is null;

-- ★ กันสร้าง entry ซ้ำต่อบิล (worker รอบทับกัน / re-run) — 1 attachment ที่ยังไม่ลบ = 1 entry
create unique index if not exists uq_bill_entries_attachment_active
  on public.bill_entries (attachment_id)
  where attachment_id is not null and deleted_at is null;

create trigger trg_bill_entries_updated before update on public.bill_entries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- bill_entry_lines — บรรทัดรายการ (รองรับบิลผสม VAT + ไม่ VAT)
--   vat_type   : vat (มี VAT 7%) | novat (ยกเว้น/ไม่คิด VAT)
--   amount     : มูลค่าก่อน VAT (ฐานภาษี)
--   vat_amount : ภาษีมูลค่าเพิ่ม (0 เมื่อ novat)
--   wht_rate   : อัตราหัก ณ ที่จ่าย % (auto-calc/คนใส่ — AI ไม่เดา)
--   wht_amount : ยอดหัก ณ ที่จ่าย (= amount * wht_rate/100 หรือคนแก้)
--   ai_filled  : true = AI เติมช่องนี้ · false = คนคีย์/ช่อง AI เว้นว่าง
--     (ตัวเลข AI เว้น null → ให้คน key แล้วเป็น false เพื่อรู้ที่มา)
-- ---------------------------------------------------------------------
create table if not exists public.bill_entry_lines (
  id           uuid primary key default gen_random_uuid(),
  entry_id     uuid not null references public.bill_entries(id) on delete cascade,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  line_no      int not null default 1,
  vat_type     text not null default 'vat' check (vat_type in ('vat','novat')),
  description  text,
  amount       numeric(14,2) default 0,
  vat_amount   numeric(14,2) default 0,
  wht_rate     numeric(5,2)  default 0,
  wht_amount   numeric(14,2) default 0,
  ai_filled    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_bill_entry_lines_entry
  on public.bill_entry_lines (tenant_id, entry_id);

create trigger trg_bill_entry_lines_updated before update on public.bill_entry_lines
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS: tenant isolation (pattern 0012/0035)
--   authenticated : SELECT เท่านั้น (อ่านในหน้าเว็บ) — write ผ่าน service_role
--     (server action ที่ guard admin) เพื่อกัน client เขียนตรงผ่าน PostgREST
--   service_role  : all (worker/server-action เบื้องหลัง — bypass RLS)
-- =====================================================================
alter table public.bill_entries      enable row level security;
alter table public.bill_entry_lines  enable row level security;

create policy tenant_read on public.bill_entries for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy tenant_read on public.bill_entry_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- GRANT posture (pattern 0013/0032/0035)
revoke all on public.bill_entries      from anon;
revoke all on public.bill_entry_lines  from anon;

grant select on public.bill_entries      to authenticated;
grant select on public.bill_entry_lines  to authenticated;

grant all on public.bill_entries      to service_role;
grant all on public.bill_entry_lines  to service_role;

-- reload PostgREST schema cache (ตารางใหม่ ไม่งั้น API มองไม่เห็น → 500 schema cache)
notify pgrst, 'reload schema';
