-- =====================================================================
-- 0070 — Sales Documents (Quotation / Purchase Order / Billing Note)
--   เฟส 3 ส่วน K (docs/06-accounting-features-roadmap.md, หมวด 1.2) — เอกสารช่วยขาย
--   ก่อน/ระหว่างขาย-ซื้อ ใช้ตารางร่วมเดียว แยกด้วย document_type (ไม่กระทบ engine บัญชีเลย, 0.11)
--
--   เลขที่เอกสาร (doc_no) = null จนกว่าจะ "ออกเอกสาร" (issue) ผ่าน RPC issue_sales_document()
--   ด้านล่าง — atomic (increment counter + ล็อกแถวเป็น issued ในทรานแซกชันเดียว) mirror pattern
--   0026_scheduled_invitation_rpc.sql
-- =====================================================================

create table if not exists public.sales_documents (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  customer_id           uuid not null references public.customers(id) on delete cascade,
  document_type         text not null check (document_type in ('quotation','purchase_order','billing_note')),
  -- doc_no = null จนกว่าจะ "ออกเอกสาร" (issue) — assign แบบ atomic ผ่าน issue_sales_document() ด้านล่าง (0.12)
  doc_no                text,
  doc_date              date not null,
  valid_until           date,  -- เฉพาะ quotation ใช้จริง (อื่น ๆ = null เสมอ ไม่บังคับด้วย DB)
  counterparty_name     text,
  counterparty_tax_id   text,
  counterparty_address  text,
  notes                 text,
  status                text not null default 'draft' check (status in ('draft','issued','void')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  issued_at             timestamptz,
  deleted_at            timestamptz
);
create unique index if not exists uq_sales_documents_tenant_doc_no
  on public.sales_documents (tenant_id, doc_no) where doc_no is not null and deleted_at is null;
create index if not exists idx_sales_documents_tenant_customer_type
  on public.sales_documents (tenant_id, customer_id, document_type) where deleted_at is null;

create table if not exists public.sales_document_lines (
  id                    uuid primary key default gen_random_uuid(),
  document_id           uuid not null references public.sales_documents(id) on delete cascade,
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  line_no               int not null default 1,
  description           text,
  product_id            uuid references public.products(id) on delete set null,
  -- อ้างอิงบิลต้นทาง (เฉพาะ billing_note, 0.14) — read-only reference, validate ที่ app layer เท่านั้น
  source_bill_entry_id  uuid references public.bill_entries(id) on delete set null,
  quantity              numeric(14,3) not null default 1,
  unit                  text,
  unit_price            numeric(14,2) not null default 0,
  amount                numeric(14,2) not null default 0,
  vat_amount            numeric(14,2) not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_sales_document_lines_document
  on public.sales_document_lines (tenant_id, document_id);

-- ตัวนับเลขที่เอกสารต่อ (tenant, ประเภทเอกสาร, ปีพ.ศ.) — ใช้เฉพาะภายใน RPC ด้านล่าง (0.12)
create table if not exists public.sales_document_counters (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  document_type   text not null check (document_type in ('quotation','purchase_order','billing_note')),
  be_year         int not null,
  last_seq        int not null default 0,
  primary key (tenant_id, document_type, be_year)
);

drop trigger if exists trg_sales_documents_updated on public.sales_documents;
create trigger trg_sales_documents_updated before update on public.sales_documents
  for each row execute function public.set_updated_at();
drop trigger if exists trg_sales_document_lines_updated on public.sales_document_lines;
create trigger trg_sales_document_lines_updated before update on public.sales_document_lines
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RPC: ออกเอกสาร (assign doc_no แบบ atomic) — increment counter + ล็อกแถวเป็น issued
--   ใน "ทรานแซกชันเดียว" (ฟังก์ชันเดียว) → ถ้าแถวไม่ใช่ draft แล้ว raise exception → rollback ทั้งหมด
--   รวม counter ที่เพิ่งเพิ่มไปด้วย (กันเลขถูกเผาทิ้งเงียบ ๆ เมื่อ race กับการ issue/void ซ้อน)
--   SECURITY DEFINER + fixed search_path; execute เฉพาะ service_role (pattern 0026)
-- =====================================================================
create or replace function public.issue_sales_document(
  p_tenant_id      uuid,
  p_document_id    uuid,
  p_document_type  text,
  p_be_year        int,
  p_prefix         text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seq int;
  v_doc_no text;
  v_updated_id uuid;
begin
  insert into public.sales_document_counters (tenant_id, document_type, be_year, last_seq)
  values (p_tenant_id, p_document_type, p_be_year, 1)
  on conflict (tenant_id, document_type, be_year)
  do update set last_seq = sales_document_counters.last_seq + 1
  returning last_seq into v_seq;

  v_doc_no := p_prefix || '-' || p_be_year::text || '-' || lpad(v_seq::text, 4, '0');

  update public.sales_documents
  set doc_no = v_doc_no, status = 'issued', issued_at = now()
  where id = p_document_id
    and tenant_id = p_tenant_id
    and document_type = p_document_type
    and status = 'draft'
    and deleted_at is null
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'sales_document not found or not draft (id=%)', p_document_id;
  end if;

  return jsonb_build_object('id', v_updated_id, 'doc_no', v_doc_no);
end;
$$;

revoke all on function public.issue_sales_document(uuid, uuid, text, int, text) from public;
grant execute on function public.issue_sales_document(uuid, uuid, text, int, text) to service_role;

comment on function public.issue_sales_document(uuid, uuid, text, int, text) is
  'ออกเลขที่เอกสารขาย/จัดซื้อ (quotation/PO/billing_note) แบบ atomic — increment counter + ล็อกเป็น issued (เฟส 3 ส่วน K, 0.12)';

alter table public.sales_documents          enable row level security;
alter table public.sales_document_lines     enable row level security;
alter table public.sales_document_counters  enable row level security;
drop policy if exists tenant_read on public.sales_documents;
create policy tenant_read on public.sales_documents for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.sales_document_lines;
create policy tenant_read on public.sales_document_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
-- sales_document_counters ไม่มี policy ให้ authenticated เลย (ไม่มีเหตุผลต้องอ่านผ่าน PostgREST)
revoke all on public.sales_documents          from anon;
revoke all on public.sales_document_lines     from anon;
revoke all on public.sales_document_counters  from anon, authenticated;
grant select on public.sales_documents          to authenticated;
grant select on public.sales_document_lines     to authenticated;
grant all on public.sales_documents          to service_role;
grant all on public.sales_document_lines     to service_role;
grant all on public.sales_document_counters  to service_role;

notify pgrst, 'reload schema';
