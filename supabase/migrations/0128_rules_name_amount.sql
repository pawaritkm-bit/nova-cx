-- 0128 (2026-09-02): learning จำ "ยอดซ้ำ ๆ" แยกเป็นคีย์เดี่ยว (กติกาผู้ใช้ — ชื่อผู้โอน "หรือ"
--   ยอดซ้ำ อย่างใดอย่างหนึ่ง เพราะยอดซ้ำคือค่าบริการฟิกราคา เช่น 5,000 = ค่าทำบัญชีรายเดือน)
--   เพิ่ม match_type 'amount' (คีย์ = ยอด 2 ตำแหน่ง ต่อ entry_type ต่อ tenant)
alter table line_account_rules drop constraint if exists line_account_rules_match_type_check;
alter table line_account_rules add constraint line_account_rules_match_type_check
  check (match_type in ('tax','name','amount'));
