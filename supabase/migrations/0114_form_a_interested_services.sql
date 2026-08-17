-- =====================================================================
-- 0114 — เพิ่มคำถาม "บริการเสริมที่สนใจ" (a_services) ใน Form A
--
--   ต่อเนื่องจากงาน CX → Sales outbound integration:
--   เมื่อลูกค้าเลือกบริการที่สนใจในแบบประเมิน ส่งสัญญาณไปสร้าง NBS recommendation
--   ที่ NOVA Sales อัตโนมัติ  แต่ Form A production ยังไม่มีคำถามนี้ (มีแค่ prototype)
--   → เพิ่ม section "services" + question code "a_services" (type: multi, exclusive: none)
--
--   option value ใช้ Sales service_code โดยตรง (เช่น tax_planning, cfo) ทำให้ mapping
--   ตรงไปตรงมา  ตัวเลือกที่ map ไม่ได้ (cx_ prefix) จะถูกข้ามโดย outbound logic
--
-- idempotent: เช็คว่ายังไม่มี section code='services' ก่อน update
-- non-destructive: เพิ่ม section ท้ายสุด ไม่แตะ section/คำถามเดิม
-- =====================================================================

UPDATE public.survey_versions sv
SET schema_json = jsonb_set(
  sv.schema_json,
  '{sections}',
  (sv.schema_json -> 'sections') || '[{
    "code": "services",
    "title": "บริการเสริมที่สนใจ",
    "questions": [{
      "code": "a_services",
      "text": "บริการเสริมที่สนใจ (เลือกได้หลายข้อ)",
      "type": "multi",
      "options": [
        {"value":"tax_planning","label":"วางแผนภาษี"},
        {"value":"internal_accounting","label":"บัญชีภายใน"},
        {"value":"system_setup","label":"วางระบบบัญชี"},
        {"value":"cfo","label":"CFO/วางแผนการเงิน"},
        {"value":"audit_closing","label":"ปิดงบ/ผู้สอบบัญชี"},
        {"value":"holding_company","label":"Holding"},
        {"value":"due_diligence","label":"Due Diligence/ซื้อขายกิจการ"},
        {"value":"reg_company","label":"จดทะเบียนบริษัท"},
        {"value":"change_director","label":"เปลี่ยนกรรมการ/ผู้ถือหุ้น/ที่ตั้ง"},
        {"value":"legal_general","label":"กฎหมายธุรกิจ/สัญญา"},
        {"value":"visa","label":"วีซ่า/ใบอนุญาตทำงาน"},
        {"value":"stock_audit","label":"ออดิทคลังสินค้า"},
        {"value":"company_closure","label":"ปิดบริษัท/หจก."},
        {"value":"none","label":"ยังไม่ต้องการ","is_exclusive":true}
      ]
    }]
  }]'::jsonb
)
FROM public.survey_templates st
WHERE sv.template_id = st.id
  AND st.survey_type = 'A'
  AND sv.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(sv.schema_json -> 'sections') s
    WHERE s ->> 'code' = 'services'
  );

notify pgrst, 'reload schema';
