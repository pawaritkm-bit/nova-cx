-- =====================================================================
-- 0038 — ผูก LINE userId กับพนักงาน (employees.line_user_id)
--
--   จุดประสงค์:
--     รองรับ "ลงทะเบียนนักบัญชีผ่าน QR (LIFF)" — นักบัญชีสแกน QR → login LINE
--     → ระบบผูก LINE userId ของเขากับแถว employees ครั้งเดียว
--     จากนั้นแชตของเขาใน "ทุกกลุ่ม" ถูก attribute เป็นพนักงานคนนี้อัตโนมัติ
--     (ingest จะ match sender line_user_id กับคอลัมน์นี้) โดยไม่ต้อง map ทีละกลุ่ม
--
--   ความปลอดภัย/ผลกระทบ:
--     - non-destructive: เพิ่มคอลัมน์ nullable เท่านั้น ไม่แตะข้อมูล/คอลัมน์เดิม
--     - idempotent: `add column if not exists` + `create unique index if not exists`
--     - unique เป็น partial (where line_user_id is not null) → พนักงานเดิมที่ยังไม่ผูก
--       LINE (line_user_id = null) ไม่ติด unique หลายแถว null ได้ตามปกติ
--       และกัน LINE userId เดียวผูกซ้ำ 2 พนักงานใน tenant เดียวกัน
--     - ไม่แตะ RLS / view / pseudonymity ใด ๆ (คอลัมน์นี้ไม่ใช่สะพานโยงคะแนน↔ตัวตนลูกค้า)
-- =====================================================================

-- LINE userId ของพนักงาน (ผูกครั้งเดียว ใช้ทุกกลุ่ม); null = ยังไม่ผูก LINE
alter table public.employees
  add column if not exists line_user_id text;

comment on column public.employees.line_user_id is
  'LINE userId ของพนักงาน (จากการลงทะเบียนผ่าน QR/LIFF) — ผูกครั้งเดียวใช้ทุกกลุ่ม; null = ยังไม่ผูก. ingest ใช้ match ผู้ส่งแชต→พนักงานอัตโนมัติ';

-- กัน LINE userId เดียวผูกซ้ำหลายพนักงานใน tenant เดียวกัน (partial: เฉพาะที่ผูกแล้ว)
create unique index if not exists uq_employees_tenant_line_user
  on public.employees (tenant_id, line_user_id)
  where line_user_id is not null;
