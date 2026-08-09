-- เฟส 2 ส่วน E (docs/06-accounting-features-roadmap.md, 0.2/E2)
-- บันทึกรับ/จ่ายเงินจริง แยกจากตัวบิล — 1 บิลเชื่อ (payment_method='credit') มีได้หลายงวด
--   ไม่มีสถานะ draft/confirmed (บันทึกแล้วถือว่าเงินเข้า/ออกจริง) แก้ไม่ได้ — ผิดพลาดต้อง soft-delete (void)
--   ไม่มี business-rule constraint ระดับ DB (เช่น amount <= ยอดค้างชำระ) — บังคับที่ application layer เท่านั้น
--   ตาม pattern เดิมทั้งระบบ (ดูหมายเหตุท้ายไฟล์ 1.2 ในแผน)

create table if not exists public.bill_payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  entry_id        uuid not null references public.bill_entries(id) on delete cascade,
  -- customer_id สำเนาจาก bill_entries ตอนบันทึก (กันต้อง join ทุกครั้งตอนกรองสโคป/รายงาน — บิลเชื่อไม่ย้าย
  -- ลูกค้าหลังยืนยันแล้วในทางปฏิบัติ ระบบไม่มี UI ให้ย้ายลูกค้าของบิล confirmed อยู่แล้ว)
  customer_id     uuid references public.customers(id) on delete set null,
  pay_date        date not null,
  amount          numeric(14,2) not null check (amount > 0),
  method          text not null check (method in ('cash','cheque','transfer')),
  bank_account_id uuid references public.customer_bank_accounts(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists idx_bill_payments_tenant_entry
  on public.bill_payments (tenant_id, entry_id)
  where deleted_at is null;
create index if not exists idx_bill_payments_tenant_customer_date
  on public.bill_payments (tenant_id, customer_id, pay_date)
  where deleted_at is null;

drop trigger if exists trg_bill_payments_updated on public.bill_payments;
create trigger trg_bill_payments_updated before update on public.bill_payments
  for each row execute function public.set_updated_at();

alter table public.bill_payments enable row level security;
drop policy if exists tenant_read on public.bill_payments;
create policy tenant_read on public.bill_payments for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.bill_payments from anon;
grant select on public.bill_payments to authenticated;
grant all on public.bill_payments to service_role;

notify pgrst, 'reload schema';
