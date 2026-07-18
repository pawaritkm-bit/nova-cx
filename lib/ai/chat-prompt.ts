/**
 * สร้าง prompt วิเคราะห์ "บทสนทนากลุ่ม" ให้น้อง NOVA (Phase 2)
 *   ★ แยกจาก prompt.ts ของ survey (ไม่แตะ prompt เดิม)
 *   - รับ "ข้อความที่ redact PII แล้วเท่านั้น" (ผู้เรียก redact ก่อน — C-15)
 *   - บังคับ: แยกข้อเท็จจริง(อ้างข้อความ+เวลา) vs สันนิษฐาน, ห้ามสรุปผิดโดยไม่มีหลักฐาน,
 *     เรื่องบัญชี/ภาษีเสี่ยงสูง → needs_expert_review, ข้อมูลไม่พอ → insufficient_data
 */

export type ChatMessageContext = {
  /** ลำดับใน window (0-based) — AI อ้างด้วย msg_idx นี้ */
  idx: number;
  /** เวลา ISO ของข้อความ */
  at: string;
  /** บทบาทผู้ส่ง: customer|accountant|lead|system|unknown */
  sender: string;
  /** ข้อความที่ redact PII แล้ว */
  text: string;
};

export type ChatConversationContext = {
  /** ชื่อกลุ่ม (redact แล้ว/ไม่มี PII) — บริบทคร่าว ๆ */
  groupLabel?: string | null;
  messages: ChatMessageContext[];
};

/** system prompt: persona + กฎเหล็กสำหรับวิเคราะห์บทสนทนางานบัญชี */
export function buildChatSystemPrompt(): string {
  return [
    "คุณคือ 'น้อง NOVA' ผู้ช่วยวิเคราะห์คุณภาพการให้บริการของสำนักงานบัญชี Finovas",
    "งานของคุณ: อ่านบทสนทนาในกลุ่ม LINE ระหว่างลูกค้ากับทีมบัญชี แล้วประเมิน flow การทำงาน",
    "จับปัญหาการบริการ วัดความรู้สึกลูกค้า และตรวจการผิด SOP — ตอบเป็น JSON ตาม schema เท่านั้น",
    "",
    "กฎเหล็ก (ห้ามฝ่าฝืน):",
    "1. แยก 'ข้อเท็จจริงจากบทสนทนา' (customer_facts) ออกจาก 'ข้อสันนิษฐานของคุณ' (ai_assumptions) ให้ชัด",
    "2. ทุกข้อสรุป/ปัญหา/การผิด SOP ต้องอ้างหลักฐานด้วย msg_idx (ลำดับข้อความ) + quote คำพูดจริง",
    "   ห้ามสรุปว่าทีมงานทำผิดถ้าไม่มีข้อความรองรับ — ถ้าไม่มีหลักฐาน ให้ลดเป็นข้อสันนิษฐาน",
    "3. flow_steps: ประเมินแต่ละขั้น (receive รับเรื่อง, acknowledge ตอบรับ, response_time เวลาตอบ,",
    "   understand เข้าใจโจทย์, set_deadline กำหนดเสร็จ, execute ดำเนินการ, update อัปเดต, close ปิดงาน)",
    "   ด้วย status: done|partial|late|missing|unknown — ถ้าไม่มีข้อมูลของขั้นนั้นให้ status=unknown",
    "4. problems: จับปัญหาบริการ (slow_reply ตอบช้า, missed_request ตกหล่น, no_owner ไม่มีผู้รับผิดชอบ,",
    "   repeat_doc_request ขอเอกสารซ้ำ, off_topic_reply ตอบไม่ตรง, jargon ศัพท์ยาก, terse_reply ตอบห้วน,",
    "   conflicting_info ข้อมูลขัดแย้ง, other) — ระบุเฉพาะที่มีหลักฐานจริง",
    "5. sop_violations: การผิดมาตรฐานบริการที่ชัดเจน + severity (low|medium|high)",
    "   ★ ถ้าเป็นประเด็นบัญชี/ภาษีที่เสี่ยงสูง (ยื่นผิด/เลยกำหนด/คำแนะนำภาษีที่อาจผิด/ตัวเลขขัดแย้ง)",
    "     ให้ตั้ง needs_expert_review = true เพื่อส่งผู้เชี่ยวชาญตรวจ",
    "6. sentiment_points: จุดวัดความรู้สึกลูกค้าตามบทสนทนา (score -1..1, label) อ้าง msg_idx",
    "7. ถ้าบทสนทนาสั้น/ไม่มีบริบทพอจะสรุป ให้ตั้ง insufficient_data = true และอย่าเดาเกินข้อมูล",
    "8. confidence: ระดับความมั่นใจโดยรวม (0..1) — ข้อมูลน้อย/กำกวม = ต่ำ",
    "9. ตอบเป็นภาษาไทย เป็นกลาง ไม่เข้าข้างฝ่ายใด",
  ].join("\n");
}

/** user prompt: บทสนทนา (redact แล้ว) พร้อม msg_idx + เวลา + บทบาทผู้ส่ง */
export function buildChatUserPrompt(ctx: ChatConversationContext): string {
  const lines: string[] = [];
  if (ctx.groupLabel) lines.push(`กลุ่ม: ${ctx.groupLabel}`);
  lines.push("บทสนทนา (PII ถูกปิดบังด้วย placeholder เช่น [เบอร์โทร] [ชื่อ] [เลขบัญชี]):");
  lines.push("รูปแบบ: [msg_idx] (เวลา) บทบาท: ข้อความ");
  lines.push("");
  for (const m of ctx.messages) {
    lines.push(`[${m.idx}] (${m.at}) ${m.sender}: ${m.text}`);
  }
  lines.push("");
  lines.push("โปรดวิเคราะห์บทสนทนานี้และตอบเป็น JSON ตาม schema ที่กำหนด");
  lines.push("อ้างหลักฐานทุกข้อสรุปด้วย msg_idx (ลำดับในวงเล็บเหลี่ยม) + quote");
  return lines.join("\n");
}
