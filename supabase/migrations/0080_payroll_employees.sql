-- =====================================================================
-- 0080 — เฟส 9 ส่วน AC (docs/06-accounting-features-roadmap.md, หมวด 0.2/0.12)
--   ทะเบียนพนักงานของ "บริษัทลูกค้า" (payroll) — คนละเอนทิตีโดยสิ้นเชิงกับ public.employees เดิม
--
--   ★★★ 0.2 ห้ามสับสนกับ public.employees (migration 0003) — public.employees คือพนักงานภายในของ
--     Finovas เอง (นักบัญชี/เซลส์/CS) ไม่มี customer_id ผูกกับ chat_groups.responsible_employee_id/
--     สิทธิ์ภายในทั้งระบบ — ตารางนี้ (payroll_employees) คือพนักงานของบริษัทลูกค้าที่ Finovas ทำเงินเดือน
--     ให้แทน (outsource model, 0.1) ต้อง scope ด้วยทั้ง tenant_id **และ** customer_id เสมอ (ต่างจาก
--     employees เดิมที่ไม่มี customer_id เลย) — ชื่อตาราง/คอลัมน์สะกดต่างจาก employees ชัดเจนตั้งใจ
--     กัน reviewer/นักพัฒนาในอนาคตสลับสโคปผิดโดยไม่ตั้งใจ (ความเสี่ยงสูงสุดของเฟสนี้)
--
--   ★ 0.12 id_card_no: เลขบัตรประชาชนไทย 13 หลัก normalize ด้วย lib/accounting/tax-id.ts::normalizeTaxId
--     ก่อนเก็บเสมอ (โค้ดชั้น data layer ทำ ไม่ใช่ DB constraint) — พนักงานต่างชาติไม่มีบัตรใช้ passport_no
--     แทนได้ (check constraint บังคับมีอย่างน้อย 1 ใน 2 ช่อง) — PDPA: หน้าจอมาสก์เป็นค่าเริ่มต้น ไม่ log เลขเต็ม
--   ★ unique id_card_no เฉพาะ "ภายในลูกค้าเดียวกัน" (ไม่ unique ข้ามลูกค้า) — พนักงานย้ายงานข้ามลูกค้าของ
--     Finovas เองได้จริง (คนละบริษัท คนละทะเบียนพนักงาน แม้เลขบัตรเดียวกัน)
--
-- non-destructive: สร้างตารางใหม่ (create if not exists) ไม่แตะ public.employees เดิมเลยแม้แต่คอลัมน์เดียว
-- =====================================================================

create table if not exists public.payroll_employees (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  customer_id    uuid not null references public.customers(id) on delete cascade,
  employee_code  text,
  full_name      text not null,
  id_card_no     text,     -- 13 หลัก, normalize ด้วย normalizeTaxId ก่อนเก็บ (0.12)
  passport_no    text,
  position       text,
  base_salary    numeric(14,2) not null default 0 check (base_salary >= 0),
  start_date     date,
  resign_date    date,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint payroll_employees_has_id_doc check (id_card_no is not null or passport_no is not null)
);
create index if not exists idx_payroll_employees_customer
  on public.payroll_employees (tenant_id, customer_id) where deleted_at is null;
create unique index if not exists uq_payroll_employees_id_card
  on public.payroll_employees (tenant_id, customer_id, id_card_no)
  where deleted_at is null and id_card_no is not null;

drop trigger if exists trg_payroll_employees_updated on public.payroll_employees;
create trigger trg_payroll_employees_updated before update on public.payroll_employees
  for each row execute function public.set_updated_at();

alter table public.payroll_employees enable row level security;
drop policy if exists tenant_read on public.payroll_employees;
create policy tenant_read on public.payroll_employees for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.payroll_employees from anon;
grant select on public.payroll_employees to authenticated;
grant all    on public.payroll_employees to service_role;

notify pgrst, 'reload schema';
