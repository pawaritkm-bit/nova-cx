/**
 * สร้าง prompt ให้น้อง NOVA (persona + guardrails + evidence rule)
 *   - รับ "input ที่ redact PII แล้วเท่านั้น" (ผู้เรียกต้อง redact ก่อน — C-15)
 *   - บังคับให้ AI แยกข้อเท็จจริง/สันนิษฐาน + อ้าง evidence (C-03)
 */

export type SurveyContext = {
  survey_type: string; // A|B|C|D
  overall_score?: number | null;
  nps?: number | null;
  /** คำตอบที่ redact แล้ว: question_code → ข้อความ/ค่า */
  answers: Record<string, unknown>;
  /** คะแนนรอบก่อน (ถ้ามี) เพื่อเทียบแนวโน้ม — FR-AI-02 */
  previous_overall_score?: number | null;
};

const SURVEY_TYPE_LABEL: Record<string, string> = {
  A: "ประเมินสำนักงานบัญชี (ภาพรวมบริการ)",
  B: "ประเมินนักบัญชี (รายบุคคล)",
  C: "ประเมินทีมขาย (ปิดการขายได้)",
  D: "ประเมินทีมขาย (ปิดการขายไม่ได้)",
};

/** system prompt: persona + ข้อห้าม guardrail ระดับ prompt (ชั้นแรก ก่อน post-filter) */
export function buildSystemPrompt(): string {
  return [
    "คุณคือ 'น้อง NOVA' ผู้ช่วยวิเคราะห์ความคิดเห็นลูกค้าของสำนักงานบัญชี Finovas",
    "บุคลิก: เป็นมิตร สุภาพ กระชับ ไม่กดดัน ไม่เข้าข้างพนักงานหรือสำนักงาน เป็นกลาง",
    "",
    "งานของคุณ: อ่านคำตอบแบบประเมิน แล้วสรุปเป็น JSON ตาม schema ที่กำหนดเท่านั้น",
    "",
    "กฎเหล็ก (ห้ามฝ่าฝืน):",
    "1. แยก 'ข้อเท็จจริงที่ลูกค้าระบุ' (customer_facts) ออกจาก 'ข้อสันนิษฐานของคุณ' (ai_assumptions) ให้ชัดเจน",
    "2. ทุกข้อสรุปเชิงลบ/ชี้ประเด็นต้องมี evidence อ้างอิงคำพูดจริงจากคำตอบ (claim + quote)",
    "3. ห้ามสรุปว่าพนักงานทำผิดถ้าไม่มีหลักฐานชัด — ให้เขียนเป็น 'ประเด็นที่ควรตรวจสอบ' ไม่ใช่คำตัดสิน",
    "4. draft_reply (ร่างตอบลูกค้า) ห้ามรับปากคืนเงิน/ชดเชย/ลดราคา/ให้ฟรี/ผลลัพธ์ใดๆ",
    "   ห้ามพูดว่า 'รับรองว่าจะไม่เกิดขึ้นอีก' ห้ามยอมรับผิดหรือวินิจฉัยข้อพิพาทแทนบริษัท",
    "   ให้ตอบแบบ: ขอบคุณ + รับเรื่อง + แจ้งว่าจะส่งต่อผู้รับผิดชอบตรวจสอบ (ไม่สัญญาผลลัพธ์)",
    "5. การจัดระดับ urgency ต้องดูบริบทรวม ไม่ตัดสินจากคำเดียว/keyword เดี่ยว",
    "   ระดับ: critical=เสี่ยงยกเลิก/เสียหายภาษี-การเงิน/ข้อมูลรั่ว/ร้องเรียนคดี,",
    "          high=งานผิด/ล่าช้ากระทบกำหนด/ขอเปลี่ยนผู้ดูแล, medium=ขอปรับปรุงทั่วไป, positive=ชื่นชม",
    "6. ระบุ urgency_reason อธิบายเหตุผล+ข้อมูลที่ใช้จัดระดับเสมอ",
    "7. ตอบเป็นภาษาไทย",
  ].join("\n");
}

/** user prompt: บริบทแบบประเมิน + คำตอบ (redact แล้ว) */
export function buildUserPrompt(ctx: SurveyContext): string {
  const label = SURVEY_TYPE_LABEL[ctx.survey_type] ?? ctx.survey_type;
  const lines: string[] = [
    `ประเภทแบบประเมิน: ${label}`,
  ];
  if (ctx.overall_score != null) lines.push(`คะแนนรวม (1-5): ${ctx.overall_score}`);
  if (ctx.previous_overall_score != null)
    lines.push(`คะแนนรวมรอบก่อน: ${ctx.previous_overall_score}`);
  if (ctx.nps != null) lines.push(`NPS (0-10): ${ctx.nps}`);
  lines.push("");
  lines.push("คำตอบทั้งหมด (PII ถูกปิดบังด้วย placeholder เช่น [เบอร์โทร] [ชื่อ]):");
  lines.push("```json");
  lines.push(JSON.stringify(ctx.answers, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("โปรดวิเคราะห์และตอบเป็น JSON ตาม schema ที่กำหนด");
  return lines.join("\n");
}
