-- =====================================================================
-- 0078 — เฟส 8 ส่วน Y (docs/06-accounting-features-roadmap.md, 0.7/0.8, T70)
--   เชื่อมกับบิลที่ยืนยันแล้ว — สร้างรายการเข้า/ออกสต็อกจากบิล (ปุ่ม manual-trigger ที่หน้ารายการบิล)
--
--   ★ 0.8 กันกดซ้ำสร้าง product_stock_movements ซ้ำสอง (double-click/สองแท็บ) — mirror หลักการ atomic
--     claim ที่ flowaccount_sync_log/bill_entries.flowaccount_sync_status ใช้ (M1/M2): เพิ่มคอลัมน์
--     stock_synced_at (nullable) แล้ว "claim" ด้วย UPDATE...WHERE stock_synced_at IS NULL...RETURNING id
--     ใน 1 คำสั่ง SQL ก่อนสร้าง movement จริง — claim ไม่ติด (ไม่ได้แถวกลับมา) = มีคนกดไปแล้ว → ปฏิเสธ
--   ★ ไม่ auto-sync ตามเมื่อบิลถูกแก้/ยกเลิกยืนยันหลังสร้างไปแล้ว (0.9) — นักบัญชีต้องยกเลิกรายการสต็อกเอง
--     ก่อนแล้วกดสร้างใหม่ (ไม่มี needs_resync flag เหมือน FlowAccount ในรอบนี้ — ตรวจ badge ที่ชั้น UI แทน)
--
-- non-destructive: ALTER เพิ่มคอลัมน์ nullable เดียว ไม่แตะตาราง/flow เดิมเลย
-- =====================================================================

alter table public.bill_entries
  add column if not exists stock_synced_at timestamptz;

notify pgrst, 'reload schema';
