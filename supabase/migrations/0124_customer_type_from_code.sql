-- 0124 — แยกประเภทลูกค้าจาก prefix ของรหัส
-- P = บุคคลธรรมดา, N = นิติบุคคล
-- อัปเดตเฉพาะแถวที่ยังไม่ระบุ เพื่อไม่ทับค่าที่ผู้ใช้ยืนยันเองไว้แล้ว

update public.customers
set customer_type = 'individual'
where customer_type is null
  and upper(left(trim(customer_code), 1)) = 'P';

update public.customers
set customer_type = 'company'
where customer_type is null
  and upper(left(trim(customer_code), 1)) = 'N';

comment on column public.customers.customer_type is
  'ประเภทลูกค้า: company = นิติบุคคล, individual = บุคคลธรรมดา; รหัส N/P ถูกเติมอัตโนมัติโดยระบบ';
