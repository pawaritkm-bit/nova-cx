-- =====================================================================
-- 0066 — ลงบันทึกบัญชีเอง (Manual Journal Entry: JV/PV/RV)
-- =====================================================================
-- บริบท: เฟส 1 ส่วน C (docs/06-accounting-features-roadmap.md) — นักบัญชีลงรายการปรับปรุงเองได้
--   (ทั่วไป/จ่ายเงิน/รับเงิน) แยกจาก bill_entries ทั้งหมด (bill_entries ผูก seller/buyer/VAT/WHT ต่อ
--   บรรทัด ไม่มีแนวคิด debit/credit ตรง ๆ แบบ JV มือ — แยกตารางกันพัง filter รายงานภาษีเดิม)
--
--   ★ tenant-scoped + ผูกลูกค้ารายเดียวต่อ entry (customer_id not null — ต่างจากผังบัญชี/สินค้าที่ไม่ผูกลูกค้า)
--   ★ soft-delete (deleted_at) — ไม่ลบจริง (pattern เดิมทั้งระบบ)
--   ★ ความสมดุล debit=credit ต่อ entry บังคับที่ "application layer" เท่านั้น (lib/accounting/manual-journal.ts)
--     เหมือน journal.ts เดิมที่ตรวจสมดุลด้วย EPSILON ไม่ใช้ DB constraint — ไม่เพิ่ม DB trigger ตรวจสมดุล
--   ★ account_code เก็บเป็นข้อความตรงตัวอักษรกับ chart_of_accounts.code (ไม่ใช้ FK จริง — pattern เดียวกับ
--     bill_entry_lines.account_code เดิม)
--
-- non-destructive: สร้างตารางใหม่ (create if not exists) ไม่แตะตาราง/flow เดิม
-- =====================================================================

create table if not exists public.manual_journal_entries (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  doc_type      text not null check (doc_type in ('JV','PV','RV')),  -- JV=ทั่วไป PV=จ่ายเงิน RV=รับเงิน
  doc_date      date not null,
  doc_no        text,
  memo          text,
  status        text not null default 'draft' check (status in ('draft','confirmed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  deleted_at    timestamptz
);
create index if not exists idx_manual_je_tenant_customer_date
  on public.manual_journal_entries (tenant_id, customer_id, doc_date)
  where deleted_at is null;

create table if not exists public.manual_journal_entry_lines (
  id            uuid primary key default gen_random_uuid(),
  entry_id      uuid not null references public.manual_journal_entries(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  line_no       int not null default 1,
  account_code  text not null,
  account_name  text,
  description   text,
  debit         numeric(14,2) not null default 0,
  credit        numeric(14,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_manual_je_lines_entry
  on public.manual_journal_entry_lines (tenant_id, entry_id);

drop trigger if exists trg_manual_je_updated on public.manual_journal_entries;
create trigger trg_manual_je_updated before update on public.manual_journal_entries
  for each row execute function public.set_updated_at();
drop trigger if exists trg_manual_je_lines_updated on public.manual_journal_entry_lines;
create trigger trg_manual_je_lines_updated before update on public.manual_journal_entry_lines
  for each row execute function public.set_updated_at();

alter table public.manual_journal_entries      enable row level security;
alter table public.manual_journal_entry_lines  enable row level security;
drop policy if exists tenant_read on public.manual_journal_entries;
create policy tenant_read on public.manual_journal_entries for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists tenant_read on public.manual_journal_entry_lines;
create policy tenant_read on public.manual_journal_entry_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.manual_journal_entries      from anon;
revoke all on public.manual_journal_entry_lines  from anon;
grant select on public.manual_journal_entries      to authenticated;
grant select on public.manual_journal_entry_lines  to authenticated;
grant all on public.manual_journal_entries      to service_role;
grant all on public.manual_journal_entry_lines  to service_role;

notify pgrst, 'reload schema';
