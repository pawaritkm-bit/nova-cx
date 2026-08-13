-- =====================================================================
-- 0110 — ใบกำกับภาษี (Tax Invoice) เต็มรูป/อย่างย่อ — wishlist backlog ข้อ "ใบกำกับภาษี"
--
--   ออกได้เฉพาะจากบิลขาย (bill_entries.entry_type='sale') ที่ยืนยันแล้ว (status='confirmed') — เป็นเอกสาร
--   ที่ยืนยัน "ยอด/VAT ที่ระบบมีอยู่แล้วจริง" ไม่ใช่กรอกยอดใหม่แยกกัน (ต่างจาก sales_documents ที่เป็น
--   เอกสารช่วยขายอิสระ กรอกยอดเองได้) — บรรทัดเก็บเป็น "สำเนา ณ เวลาออกเอกสาร" (snapshot) จาก
--   bill_entry_lines เหมือน sales_document_lines::billing_note (migration 0070) กันเอกสารเปลี่ยนย้อนหลัง
--   ถ้ามีคนแก้บิลต้นทางทีหลัง
--
--   ★ เลขที่เอกสาร (doc_no) assign แบบ atomic ผ่าน RPC issue_tax_invoice() — mirror
--     issue_sales_document (0070) เป๊ะ ทั้ง pattern (SECURITY DEFINER, service_role-only execute,
--     insert 2 ตาราง + increment counter ในทรานแซกชันเดียว)
--   ★ ต่างจาก sales_document_counters ตรงที่ตัวนับที่นี่รวม customer_id เข้าไปด้วย
--     (tenant_id, customer_id, form_type, be_year) — เพราะใบกำกับภาษีเป็นเอกสารที่กฎหมายบังคับให้แต่ละ
--     "นิติบุคคล" (=ลูกค้าของสำนักงานบัญชี 1 ราย) ต้องมีเลขต่อเนื่องของตัวเองแยกจากลูกค้ารายอื่น
--     (sales_documents/QT-PO-BN ไม่ใช่เอกสารทางภาษี เลยไม่บังคับแบบนี้ ใช้ตัวนับรวม tenant พอ)
--   ★ 1 บิลขาย ออกใบกำกับภาษีที่ยัง "ไม่ยกเลิก" ได้สูงสุด 1 ใบเท่านั้น (unique partial index +
--     เช็คซ้ำในตัว RPC) — ออกผิดต้องยกเลิก (void) แล้วออกใบใหม่ เลขเดิมไม่ reuse (เหมือน sales_documents)
--   ★ ไม่มีสถานะ draft (ต่างจาก sales_documents) — เนื้อหามาจากบิลที่ยืนยันแล้วอยู่แล้ว ไม่มีอะไรต้อง
--     แก้ก่อนออกเอกสาร กด "ออกใบกำกับภาษี" ครั้งเดียวคือ insert+เลขที่พร้อมกันเลย
--   ★ ไม่กระทบ accounting engine เลย (ห้าม import journal.ts/ledger.ts/statements.ts) — VAT ที่แสดงเป็น
--     แค่การแสดงยอดที่ผังบัญชีลงไว้แล้วตอนยืนยันบิล ไม่ใช่การลงบัญชีซ้ำ
-- =====================================================================

create table if not exists public.tax_invoices (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  customer_id            uuid not null references public.customers(id) on delete cascade,
  -- บิลขายต้นทาง (ต้อง confirmed ตอนออกเอกสาร — บังคับที่ application layer) — on delete restrict กันลบ
  -- บิลที่มีใบกำกับภาษีออกไปแล้วทิ้งไปเงียบ ๆ (ต้อง void ใบกำกับภาษีก่อนถ้าจะลบบิล)
  source_bill_entry_id   uuid not null references public.bill_entries(id) on delete restrict,
  form_type              text not null check (form_type in ('full', 'abbreviated')),
  doc_no                 text not null,
  doc_date               date not null,
  -- ผู้ซื้อ — เต็มรูปบังคับกรอก (application layer), อย่างย่อไม่บังคับ (ไม่ต้องระบุตัวผู้ซื้อ)
  buyer_name             text,
  buyer_tax_id           text,
  buyer_address          text,
  buyer_branch           text,
  seller_branch          text,
  status                 text not null default 'issued' check (status in ('issued', 'void')),
  void_reason            text,
  voided_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);
-- ★ สโคป (tenant_id, customer_id, doc_no) ไม่ใช่ (tenant_id, doc_no) — ตัวนับ tax_invoice_counters
--   แยกคีย์ต่อลูกค้า (0.1) ดังนั้นลูกค้าคนละรายในเทแนนต์เดียวกันจะได้เลขซ้ำกันได้โดยตั้งใจ (ต่างคนต่างเริ่ม
--   ที่ 1) unique index ต้องรวม customer_id เข้าไปด้วย ไม่งั้น insert จะชนกันข้ามลูกค้า
create unique index if not exists uq_tax_invoices_customer_doc_no
  on public.tax_invoices (tenant_id, customer_id, doc_no) where deleted_at is null;
-- 1 บิล มีใบกำกับภาษีที่ยัง "ไม่ยกเลิก" ได้สูงสุด 1 ใบ
create unique index if not exists uq_tax_invoices_active_per_bill
  on public.tax_invoices (tenant_id, source_bill_entry_id) where status <> 'void' and deleted_at is null;
create index if not exists idx_tax_invoices_tenant_customer
  on public.tax_invoices (tenant_id, customer_id) where deleted_at is null;

create table if not exists public.tax_invoice_lines (
  id                          uuid primary key default gen_random_uuid(),
  tax_invoice_id              uuid not null references public.tax_invoices(id) on delete cascade,
  tenant_id                   uuid not null references public.tenants(id) on delete cascade,
  line_no                     int not null default 1,
  description                 text,
  quantity                    numeric(14,3) not null default 1,
  unit                        text,
  unit_price                  numeric(14,2) not null default 0,
  -- ยอดก่อน VAT ต่อบรรทัด (tax base) — สำเนา ณ เวลาออกเอกสารจาก bill_entry_lines.amount
  amount                      numeric(14,2) not null default 0,
  vat_type                    text not null default 'vat' check (vat_type in ('vat', 'novat')),
  vat_amount                  numeric(14,2) not null default 0,
  -- อ้างอิงบรรทัดบิลต้นทาง (read-only reference, snapshot — ไม่ sync ย้อนหลัง mirror 0070 0.14)
  source_bill_entry_line_id   uuid references public.bill_entry_lines(id) on delete set null
);
create index if not exists idx_tax_invoice_lines_invoice
  on public.tax_invoice_lines (tenant_id, tax_invoice_id);

-- ตัวนับเลขที่ต่อ (tenant, ลูกค้า, รูปแบบ, ปีพ.ศ.) — ใช้เฉพาะภายใน RPC ด้านล่างเท่านั้น
-- ★ รวม customer_id เข้าไปในคีย์ (ต่างจาก sales_document_counters) — แต่ละลูกค้าต้องมีเลขต่อเนื่องแยกกัน
create table if not exists public.tax_invoice_counters (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  form_type     text not null check (form_type in ('full', 'abbreviated')),
  be_year       int not null,
  last_seq      int not null default 0,
  primary key (tenant_id, customer_id, form_type, be_year)
);

drop trigger if exists trg_tax_invoices_updated on public.tax_invoices;
create trigger trg_tax_invoices_updated before update on public.tax_invoices
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- RPC: ออกใบกำกับภาษี (assign doc_no แบบ atomic) — mirror issue_sales_document (0070) เป๊ะ
--   ต่างจาก 0070 ตรงที่ insert 2 ตาราง (header + lines) ในฟังก์ชันเดียวกันเลย เพราะไม่มี draft
--   มาก่อน (ทั้งหัว+บรรทัดถูกสร้างพร้อมเลขที่ในทีเดียว ไม่ใช่แค่ assign เลขให้แถวที่มีอยู่แล้ว)
-- ---------------------------------------------------------------------
create or replace function public.issue_tax_invoice(
  p_tenant_id             uuid,
  p_customer_id           uuid,
  p_source_bill_entry_id  uuid,
  p_form_type             text,
  p_doc_date              date,
  p_be_year               int,
  p_prefix                text,
  p_buyer_name            text,
  p_buyer_tax_id          text,
  p_buyer_address         text,
  p_buyer_branch          text,
  p_seller_branch         text,
  p_lines                 jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seq int;
  v_doc_no text;
  v_invoice_id uuid;
begin
  if exists (
    select 1 from public.tax_invoices
    where tenant_id = p_tenant_id
      and source_bill_entry_id = p_source_bill_entry_id
      and status <> 'void'
      and deleted_at is null
  ) then
    raise exception 'already_issued_for_this_bill';
  end if;

  insert into public.tax_invoice_counters (tenant_id, customer_id, form_type, be_year, last_seq)
  values (p_tenant_id, p_customer_id, p_form_type, p_be_year, 1)
  on conflict (tenant_id, customer_id, form_type, be_year)
  do update set last_seq = tax_invoice_counters.last_seq + 1
  returning last_seq into v_seq;

  v_doc_no := p_prefix || '-' || p_be_year::text || '-' || lpad(v_seq::text, 5, '0');

  insert into public.tax_invoices (
    tenant_id, customer_id, source_bill_entry_id, form_type, doc_no, doc_date,
    buyer_name, buyer_tax_id, buyer_address, buyer_branch, seller_branch, status
  ) values (
    p_tenant_id, p_customer_id, p_source_bill_entry_id, p_form_type, v_doc_no, p_doc_date,
    p_buyer_name, p_buyer_tax_id, p_buyer_address, p_buyer_branch, p_seller_branch, 'issued'
  ) returning id into v_invoice_id;

  insert into public.tax_invoice_lines (
    tax_invoice_id, tenant_id, line_no, description, quantity, unit, unit_price, amount, vat_type, vat_amount, source_bill_entry_line_id
  )
  select
    v_invoice_id,
    p_tenant_id,
    (elem->>'line_no')::int,
    elem->>'description',
    (elem->>'quantity')::numeric,
    elem->>'unit',
    (elem->>'unit_price')::numeric,
    (elem->>'amount')::numeric,
    coalesce(elem->>'vat_type', 'vat'),
    coalesce((elem->>'vat_amount')::numeric, 0),
    (elem->>'source_bill_entry_line_id')::uuid
  from jsonb_array_elements(p_lines) as elem;

  return jsonb_build_object('id', v_invoice_id, 'doc_no', v_doc_no);
end;
$$;

revoke all on function public.issue_tax_invoice(uuid, uuid, uuid, text, date, int, text, text, text, text, text, text, jsonb) from public;
grant execute on function public.issue_tax_invoice(uuid, uuid, uuid, text, date, int, text, text, text, text, text, text, jsonb) to service_role;

comment on function public.issue_tax_invoice(uuid, uuid, uuid, text, date, int, text, text, text, text, text, text, jsonb) is
  'ออกเลขที่ใบกำกับภาษี (เต็มรูป/อย่างย่อ) แบบ atomic — increment counter ต่อลูกค้า + insert หัว+บรรทัดในทรานแซกชันเดียว';

alter table public.tax_invoices          enable row level security;
alter table public.tax_invoice_lines     enable row level security;
alter table public.tax_invoice_counters  enable row level security;

drop policy if exists tenant_read on public.tax_invoices;
create policy tenant_read on public.tax_invoices for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.tax_invoice_lines;
create policy tenant_read on public.tax_invoice_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
-- tax_invoice_counters ไม่มี policy ให้ authenticated เลย (ไม่มีเหตุผลต้องอ่านผ่าน PostgREST ตรง — mirror 0070)

revoke all on public.tax_invoices          from anon;
revoke all on public.tax_invoice_lines     from anon;
revoke all on public.tax_invoice_counters  from anon, authenticated;
grant select on public.tax_invoices          to authenticated;
grant select on public.tax_invoice_lines     to authenticated;
grant all on public.tax_invoices          to service_role;
grant all on public.tax_invoice_lines     to service_role;
grant all on public.tax_invoice_counters  to service_role;

notify pgrst, 'reload schema';
