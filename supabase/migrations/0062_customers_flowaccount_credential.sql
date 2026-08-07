-- =====================================================================
-- 0062 — FlowAccount credential ต่อลูกค้า (M2: หลายบริษัทพร้อมกันได้จริง)
-- =====================================================================
-- บริบท (docs/05-flowaccount-integration.md หมวด M2):
--   M1 ใช้ env กลาง (FLOWACCOUNT_CLIENT_ID/SECRET) — รองรับได้แค่ 1 บริษัทลูกค้า
--   M2 ย้าย credential มาเก็บต่อลูกค้าแต่ละราย (เข้ารหัส) ให้เปิดใช้พร้อมกันหลายบริษัทได้จริง
--
--   flowaccount_client_id         : plain text (เทียบเท่า "username"/public identifier ไม่ใช่ secret)
--   flowaccount_client_secret_enc : ciphertext เท่านั้น (เข้ารหัสด้วย lib/crypto/field.ts::encryptField()
--                                   ก่อนเขียนทุกครั้ง — ห้าม plaintext ลงคอลัมน์นี้เด็ดขาดในทุก code path)
--
--   ทั้งคู่ nullable — ลูกค้าที่ยังไม่กรอก = ยังไม่เปิดใช้การเชื่อมต่อ FlowAccount (ไม่กระทบลูกค้ารายอื่น)
--
-- non-destructive: เพิ่มคอลัมน์ (nullable) บน customers เท่านั้น (pattern 0058/0059)
--   ไม่มี RLS ใหม่ — ใช้ policy เดิมของตาราง customers
-- =====================================================================

alter table public.customers
  add column if not exists flowaccount_client_id text,
  add column if not exists flowaccount_client_secret_enc text;

comment on column public.customers.flowaccount_client_id is
  'FlowAccount OAuth client_id ของลูกค้ารายนี้ (plain — ไม่ใช่ secret)';
comment on column public.customers.flowaccount_client_secret_enc is
  'FlowAccount OAuth client_secret — เข้ารหัสด้วย lib/crypto/field.ts (encryptField) เท่านั้น ห้าม plaintext';

-- reload schema cache ของ PostgREST (กัน 500 "column not found in schema cache"
--   หลัง apply — ดูบทเรียนทีม supabase-schema-cache-reload)
notify pgrst, 'reload schema';
