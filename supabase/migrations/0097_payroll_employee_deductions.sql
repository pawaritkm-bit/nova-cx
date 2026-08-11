-- =====================================================================
-- 0097 — เฟส 9b กลุ่ม BE (docs/06-accounting-features-roadmap.md, หมวด 0.2 gate + T150) — ★★★
--   ค่าลดหย่อนภาษีอื่นของพนักงาน (คู่สมรสไม่มีเงินได้/บุตร/ประกันชีวิต/PVD-RMF-กบข/ดอกเบี้ยกู้บ้าน)
--
--   ★★★ 0.2 เสี่ยงกฎหมายสูง — ตารางนี้แค่ "เก็บข้อมูล" ยอดค่าลดหย่อนที่นักบัญชีกรอก ไม่มีสูตรคำนวณ/cap
--     อยู่ในชั้น DB เลย (cap ทั้งหมดอยู่ที่ lib/accounting/payroll-deductions.ts::sumAndCapDeductions
--     ล้วน) — และตัวเลขที่คำนวณได้จากตารางนี้**ไม่กระทบยอดภาษีหัก ณ ที่จ่ายจริง** (payroll_run_lines.
--     pit_withheld) จนกว่า ENABLE_EXTRA_DEDUCTIONS_IN_PIT (payroll-tax.ts) จะเปิดเป็น true พร้อม
--     golden test ที่ verify แล้วเท่านั้น (ดูคอมเมนต์เต็มใน payroll-tax.ts/payroll.ts::recalcRunLines)
--
--   ★ ไม่ unique ต่อ (payroll_employee_id, tax_year, deduction_type) โดยตั้งใจ — เช่น deduction_type='child'
--     ต้องกรอกได้หลายแถวต่อพนักงาน 1 คน (1 แถวต่อบุตร 1 คน เพราะแต่ละคนอาจได้ 30,000 หรือ 60,000 คนละ
--     ค่าตามกติกาปีเกิด/ลำดับบุตรที่ระบบไม่ auto-derive, T152) — deduction_type อื่นก็เผื่อไว้ให้กรอกหลายแถว
--     ได้เช่นกัน (เช่น เบี้ยประกันชีวิตของผู้มีเงินได้ + ของคู่สมรสคนละแถว) sumAndCapDeductions รวม (sum)
--     ทุกแถวของ deduction_type เดียวกันก่อน cap เสมอ
--   ★ tax_year เป็น **พ.ศ.** (ตาม convention เดิมทั้งระบบของ payroll_runs.pay_period_year) — ใช้จับคู่กับ
--     payroll_run_lines ผ่าน payroll_runs.pay_period_year (1 ปีภาษี = ค่าลดหย่อนชุดเดียวกันทุกงวดในปีนั้น)
--   ★ deduction_type check เป็นรายการปิด (closed list) ที่ชั้น DB ด้วย (defense-in-depth คู่กับ validate
--     ชั้นแอปพลิเคชันใน payroll-deductions.ts) กัน insert ค่าที่ระบบไม่รู้จักหลุดเข้ามาได้แม้ผ่าน client อื่น
--   ★ ไม่ soft-delete แยก — ลบทั้งแถวตรง ๆ ได้ (mirror payroll_run_lines, ข้อมูลนี้แก้ไข/ลบได้เสมอไม่ผูก
--     กับสถานะ finalized ของรอบเงินเดือนใด ๆ เพราะเป็นข้อมูลระดับปีภาษีของพนักงาน ไม่ใช่ระดับรอบจ่าย)
--
--   ★ payroll_employees.annual_income_estimate_override (T150 อีกส่วน) — ยอดประมาณเงินได้ทั้งปีที่
--     นักบัญชีกรอกเอง (nullable) ใช้เป็นฐานคำนวณเพดาน PVD/RMF/กบข (≤30% ของเงินได้) ใน sumAndCapDeductions
--     — ไม่กรอก (null) ให้ payroll.ts::recalcRunLines/getRunWithLines ประมาณจาก grossThisPeriod×periodsPerYear
--     ของรอบปัจจุบันแทน (ดูคอมเมนต์เต็มใน payroll.ts)
-- =====================================================================

create table if not exists public.payroll_employee_deductions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  payroll_employee_id  uuid not null references public.payroll_employees(id) on delete cascade,
  tax_year             int not null check (tax_year between 2500 and 2700),
  deduction_type       text not null check (deduction_type in (
                          'spouse_no_income',
                          'child',
                          'life_insurance',
                          'provident_fund',
                          'mortgage_interest'
                        )),
  amount               numeric(14,2) not null default 0 check (amount >= 0),
  note                 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_payroll_employee_deductions_emp_year
  on public.payroll_employee_deductions (tenant_id, payroll_employee_id, tax_year);

drop trigger if exists trg_payroll_employee_deductions_updated on public.payroll_employee_deductions;
create trigger trg_payroll_employee_deductions_updated before update on public.payroll_employee_deductions
  for each row execute function public.set_updated_at();

alter table public.payroll_employee_deductions enable row level security;
drop policy if exists tenant_read on public.payroll_employee_deductions;
create policy tenant_read on public.payroll_employee_deductions for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.payroll_employee_deductions from anon;
grant select on public.payroll_employee_deductions to authenticated;
grant all    on public.payroll_employee_deductions to service_role;

-- ★ T150 — ยอดประมาณเงินได้ทั้งปีที่นักบัญชีกรอกเอง (nullable, ไม่กรอก = ให้ระบบประมาณจากยอดรายเดือน
--   ปัจจุบัน×จำนวนงวด) ใช้เป็นฐานคำนวณเพดาน PVD/RMF/กบข ≤30% ของเงินได้ (sumAndCapDeductions) เท่านั้น
--   — ไม่กระทบสูตรคำนวณภาษีหัก ณ ที่จ่ายรายเดือนโดยตรงแต่อย่างใด
alter table public.payroll_employees
  add column if not exists annual_income_estimate_override numeric(14,2)
    check (annual_income_estimate_override is null or annual_income_estimate_override >= 0);

notify pgrst, 'reload schema';
