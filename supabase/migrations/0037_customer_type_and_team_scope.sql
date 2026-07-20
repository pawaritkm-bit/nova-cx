-- =====================================================================
-- 0037 — ประเภทลูกค้า (นิติบุคคล/บุคคลธรรมดา) + ทีมดูแลตามประเภท
--
--   จุดประสงค์:
--     1) customers.customer_type — ระบุว่าลูกค้าเป็น "นิติบุคคล (company)"
--        หรือ "บุคคลธรรมดา (individual)"
--        nullable → ลูกค้าเดิมทุกรายยังเป็น null (= ยังไม่จัดประเภท) จนกว่า
--        แอดมินจะเข้ามาระบุผ่านหน้า /admin
--     2) teams.handles_customer_type — ป้ายว่าทีมนี้รับดูแลประเภทไหน
--        nullable (null = ดูแลทั้งสองประเภท / ไม่ระบุ)
--
--   ความปลอดภัย/ผลกระทบ:
--     - non-destructive: เพิ่มคอลัมน์ nullable เท่านั้น ไม่แตะข้อมูล/คอลัมน์เดิม
--     - idempotent: ใช้ `add column if not exists` + inline CHECK (ไม่ตั้งชื่อ
--       constraint เอง → รันซ้ำแล้วข้ามทั้งคอลัมน์ ไม่มีชื่อ constraint ชนกัน)
--     - ไม่แตะ RLS / view / pseudonymity ใด ๆ (คอลัมน์นี้ไม่ใช่สะพานโยงคะแนน↔ตัวตน)
-- =====================================================================

-- ลูกค้า: ประเภทนิติบุคคล/บุคคลธรรมดา (null = ยังไม่จัดประเภท)
alter table public.customers
  add column if not exists customer_type text
    check (customer_type in ('company', 'individual'));

comment on column public.customers.customer_type is
  'ประเภทลูกค้า: company = นิติบุคคล (บริษัท), individual = บุคคลธรรมดา; null (ค่าเริ่มต้น/ลูกค้าเดิม) = ยังไม่จัดประเภท';

-- ทีม: ดูแลลูกค้าประเภทไหน (null = ดูแลทั้งสองประเภท/ไม่ระบุ)
alter table public.teams
  add column if not exists handles_customer_type text
    check (handles_customer_type in ('company', 'individual'));

comment on column public.teams.handles_customer_type is
  'ทีมนี้ดูแลลูกค้าประเภทไหน: company = นิติบุคคล, individual = บุคคลธรรมดา; null = ดูแลทั้งสองประเภท/ไม่ระบุ';
