-- 0125 — ธงต่อลูกค้า: สร้าง "บิลขาย (ร่าง)" จากเงินเข้าในสเตทเมนต์/รายงานแพลตฟอร์ม อัตโนมัติ
--   เมื่อไฟล์วิ่งมาจากกลุ่มไลน์ (auto-read → OneDrive) — ปิดเป็นค่าเริ่มต้น (opt-in ต่อราย)
--   ★ เหตุที่ต้อง opt-in: ลูกค้าที่ส่งทั้ง "บิลจริง" และ "สเตทเมนต์" ถ้าเปิดทุกราย รายได้จะซ้ำสองทาง
--   (ปุ่มสร้างบิลจากหน้าอัปโหลดเอง ไม่เกี่ยวธงนี้ — เป็นการกดสั่งเองเสมอ)
alter table public.customers
  add column if not exists auto_bills_from_statement boolean not null default false;

comment on column public.customers.auto_bills_from_statement is
  'true = สร้างบิลขายร่างจากเงินเข้าในสเตทเมนต์/รายงานแพลตฟอร์มที่ส่งเข้ากลุ่มไลน์อัตโนมัติ (กันรายได้ซ้ำ: เปิดเฉพาะลูกค้าที่ใช้สเตทเมนต์เป็นแหล่งรายได้หลัก)';

notify pgrst, 'reload schema';
