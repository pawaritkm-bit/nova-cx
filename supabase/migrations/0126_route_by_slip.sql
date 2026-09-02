-- 0126: กลุ่มไลน์รวมหลายบริษัท (requirement 2026-09-02)
--   กลุ่ม "รับเงินรายเดือน" ของพี่สวย = ลูกค้าทั้ง 6 รายส่งสลิปเข้ากลุ่มเดียว
--   → กลุ่มไม่ผูก customer_id ตายตัว แต่เปิดธงนี้ให้ worker "แยกบริษัทอัตโนมัติตามสลิป":
--     อ่านสลิปแล้วเทียบชื่อ/เลขภาษีผู้รับเงินกับลูกค้าในความดูแลของ responsible_employee_id
--     ตรงรายเดียว = ผูกบิลให้รายนั้น · กำกวม/ไม่ตรง = บิลเข้า "ยังไม่จับคู่" ให้คนเลือก
alter table chat_groups
  add column if not exists route_by_slip boolean not null default false;

comment on column chat_groups.route_by_slip is
  'กลุ่มรวมหลายบริษัท: อ่านสลิปแล้วแยกบิลเข้าบริษัทอัตโนมัติ (ลูกค้าของ responsible_employee_id) — ไม่ผูก customer_id ตายตัว';
