-- =====================================================================
-- 0028 — Partial unique index: กันผู้ดูแล "ปัจจุบัน" ซ้ำต่อคู่ (customer, employee)
--   ปัญหา: createAssignment ทำ 3 query (find→close→insert) ไม่ atomic
--     ถ้า 2 request มาพร้อมกัน อาจสร้างแถว current ซ้ำของคู่เดิมได้
--   แก้: บังคับที่ระดับ DB — คู่ (tenant_id, customer_id, employee_id) มีได้
--     เพียง 1 แถวที่เป็น "ปัจจุบัน" (valid_to null และยังไม่ถูกลบ)
--     ★ ลูกค้าคนเดียวมีผู้ดูแลได้หลายคน (lead+member) — จำกัดเฉพาะ "คู่ซ้ำ" เท่านั้น
--   หมายเหตุ: ข้อมูล demo ปัจจุบันคู่ (customer,employee) ไม่ซ้ำ → สร้าง index ผ่าน
--   ฝั่งแอป (createAssignment) จับ 23505 → แจ้งสุภาพว่ามีมอบหมายคู่นี้อยู่แล้ว
-- =====================================================================

create unique index if not exists uq_cust_assign_current
  on public.customer_assignments (tenant_id, customer_id, employee_id)
  where valid_to is null and deleted_at is null;
