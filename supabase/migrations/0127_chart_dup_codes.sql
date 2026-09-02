-- 0127 (2026-09-02): กติกาผังบัญชีใหม่จากผู้ใช้ — "เลขซ้ำได้ ชื่อห้ามซ้ำ"
--   เช่น 4010 ขายสินค้า และ 4010 รายได้บริการ อยู่คู่กันได้ (ชื่อคนละความหมาย รหัส GL เดียวกัน)
--   สมุดบัญชี/แยกประเภทรวมยอดตาม "รหัส" เหมือนเดิม — ชื่อเป็นป้ายช่วยเลือกเท่านั้น
drop index if exists uq_chart_of_accounts_tenant_code;
create unique index if not exists uq_chart_of_accounts_tenant_code_name
  on public.chart_of_accounts (tenant_id, code, name) where deleted_at is null;
-- ชื่อห้ามซ้ำ (บังคับที่ validation ชั้นแอป — ไม่ใส่ unique(name) ระดับ DB เพราะข้อมูลเดิม
-- บางเทนแนนต์อาจมีชื่อซ้ำอยู่แล้ว จะทำ migration ล้ม)
