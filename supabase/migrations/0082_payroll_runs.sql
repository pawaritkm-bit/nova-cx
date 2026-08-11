-- =====================================================================
-- 0082 — เฟส 9 ส่วน AD (docs/06-accounting-features-roadmap.md, หมวด 0.3/0.7/0.9/0.14)
--   รอบเงินเดือน 1 รอบ = 1 เดือนจ่ายของลูกค้า 1 ราย
--
--   ★ 0.14 unique ต่อ (tenant_id, customer_id, pay_period_year, pay_period_month) เฉพาะแถวที่ยังไม่ลบ
--     (partial unique index) — กันสร้างรอบเดือน/ปีเดียวกันซ้ำสองโดยไม่ตั้งใจ, soft-delete แล้วสร้างใหม่
--     เดือน/ปีเดียวกันได้ (unique เฉพาะแถวที่ยังไม่ลบ)
--   ★ 0.7/0.9 manual_entry_id (nullable, FK manual_journal_entries) — ผูก JE ที่สร้างจากรอบนี้ (draft
--     เสมอผ่าน upsertManualEntry) — atomic claim กันกดปุ่ม "สร้าง JE" ซ้ำสอง (0.9) ทำที่ชั้นแอปพลิเคชัน
--     lib/accounting/payroll.ts โดยใช้คอลัมน์ `status` เป็นตัวกั้น atomic (draft→finalized แบบ
--     UPDATE...WHERE status='draft' AND manual_entry_id is null...RETURNING id ก่อนเรียก
--     upsertManualEntry) — ★ หมายเหตุ deviation เล็กน้อยจากคำบรรยายในเอกสารแผน (ที่เขียนว่า
--     "UPDATE...SET manual_entry_id=...WHERE manual_entry_id IS NULL" ตรง ๆ): เขียนแบบนั้นไม่ได้จริง
--     เพราะ manual_entry_id เป็น FK ไปยัง manual_journal_entries — ยังไม่มีแถวจริงให้ชี้ตอน claim (ก่อน
--     เรียก upsertManualEntry) จะใส่ค่า placeholder ที่ไม่มีจริงไม่ได้ (ละเมิด FK constraint) → ใช้ `status`
--     (คอลัมน์เดียว, มีอยู่แล้วในตารางนี้) เป็นตัวกั้น atomic แทนโดยเจตนาเดียวกันทุกประการ (single UPDATE...
--     WHERE...RETURNING ก่อนเรียก upsertManualEntry เสมอ) แล้วค่อยเซ็ต manual_entry_id เป็นค่าจริงทีหลัง
--     เมื่อสร้าง JE สำเร็จแล้ว (ดู lib/accounting/payroll.ts::generateRunJournalEntry สำหรับรายละเอียดเต็ม)
--   ★ 0.3 pit_filing_status/sso_filing_status — mirror manual-trigger sync-status pattern ของเฟส 5/8
--     (stock_synced_at) เก็บสถานะ "บันทึกว่ายื่นแล้ว" ต่อรอบ (ไม่ใช่ต่อพนักงาน — ภ.ง.ด.1/สปส.1-10 ยื่นเอกสาร
--     เดียวรวมพนักงานทั้งหมดของเดือนนั้น 1 ครั้ง)
--   ★ pit_filed_by/sso_filed_by ชี้ไป public.employees (นักบัญชี Finovas ผู้กดยืนยัน) **ไม่ใช่**
--     payroll_employees (พนักงานลูกค้า) — ตั้งใจต่างจากตารางอื่นในเฟสนี้ที่ชี้ payroll_employees ทั้งหมด
--     เพราะนี่คือ "ใครเป็นคนกดปุ่มในระบบ" ไม่ใช่ "พนักงานของลูกค้าที่ถูกจ่ายเงินเดือน" (0.2 หมายเหตุความเสี่ยง)
-- =====================================================================

create table if not exists public.payroll_runs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  customer_id       uuid not null references public.customers(id) on delete cascade,
  pay_period_year   int not null check (pay_period_year between 2500 and 2700),
  pay_period_month  int not null check (pay_period_month between 1 and 12),
  pay_date          date not null,
  status            text not null default 'draft' check (status in ('draft','finalized')),
  manual_entry_id   uuid references public.manual_journal_entries(id) on delete set null,
  pit_filing_status text not null default 'not_filed' check (pit_filing_status in ('not_filed','filed')),
  pit_filed_at      timestamptz,
  pit_filed_by      uuid references public.employees(id) on delete set null,
  sso_filing_status text not null default 'not_filed' check (sso_filing_status in ('not_filed','filed')),
  sso_filed_at      timestamptz,
  sso_filed_by      uuid references public.employees(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create unique index if not exists uq_payroll_runs_period
  on public.payroll_runs (tenant_id, customer_id, pay_period_year, pay_period_month)
  where deleted_at is null;
create index if not exists idx_payroll_runs_customer
  on public.payroll_runs (tenant_id, customer_id) where deleted_at is null;

drop trigger if exists trg_payroll_runs_updated on public.payroll_runs;
create trigger trg_payroll_runs_updated before update on public.payroll_runs
  for each row execute function public.set_updated_at();

alter table public.payroll_runs enable row level security;
drop policy if exists tenant_read on public.payroll_runs;
create policy tenant_read on public.payroll_runs for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.payroll_runs from anon;
grant select on public.payroll_runs to authenticated;
grant all    on public.payroll_runs to service_role;

notify pgrst, 'reload schema';
