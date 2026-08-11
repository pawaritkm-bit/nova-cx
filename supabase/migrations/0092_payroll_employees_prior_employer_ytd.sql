-- =====================================================================
-- 0092 — เฟส 9b กลุ่ม BD (docs/06-accounting-features-roadmap.md, หมวด 0.4) — ยอดยกมาจากนายจ้างเดิม
--   (YTD) ของพนักงานที่เข้าใหม่ระหว่างปี — ★★★ เป็น "ข้อมูลอ้างอิงเพื่อพิมพ์เอกสารเท่านั้น" (หนังสือรับรอง
--   หัก ณ ที่จ่าย/50 ทวิ ปลายปี) ห้ามใช้ 3 ค่านี้ผสมเข้าสูตรคำนวณภาษีหัก ณ ที่จ่ายรายเดือนเด็ดขาด — สถาปัตยกรรม
--   เดิมของเฟส 9 (lib/accounting/payroll-tax.ts, หมวด 0.4) ตั้งใจคำนวณอิสระทุกงวดไม่พึ่งยอดสะสม (YTD) ข้ามงวด
--   ถ้าผสมยอด YTD นายจ้างเดิมเข้าสูตรจะกระทบพนักงานทุกคนที่ไม่มี YTD โดยไม่จำเป็น (regression risk สูงสุด) —
--   การ reconcile ข้ามนายจ้างเป็นหน้าที่พนักงานตอนยื่น ภ.ง.ด.90/91 เองอยู่แล้ว
--
-- ใช้งาน: lib/accounting/payroll-wht-cert.ts (ใหม่) แสดงยอด YTD นี้เป็นบรรทัดอ้างอิงแยกต่างหากตอนพิมพ์
--   หนังสือรับรองหัก ณ ที่จ่ายปลายปี — ไม่แตะ payroll-tax.ts/payroll.ts::recalcRunLines เลยแม้แต่บรรทัดเดียว
--
-- non-destructive: ALTER เพิ่ม 4 คอลัมน์ nullable — พนักงานเดิมทุกคนเป็น null (ไม่มีผลใด ๆ จนกว่าจะกรอกเอง)
-- =====================================================================

alter table public.payroll_employees
  add column if not exists prior_employer_ytd_gross         numeric(14,2) check (prior_employer_ytd_gross is null or prior_employer_ytd_gross >= 0),
  add column if not exists prior_employer_ytd_pit_withheld  numeric(14,2) check (prior_employer_ytd_pit_withheld is null or prior_employer_ytd_pit_withheld >= 0),
  add column if not exists prior_employer_ytd_sso_employee  numeric(14,2) check (prior_employer_ytd_sso_employee is null or prior_employer_ytd_sso_employee >= 0),
  add column if not exists prior_employer_note              text;

notify pgrst, 'reload schema';
