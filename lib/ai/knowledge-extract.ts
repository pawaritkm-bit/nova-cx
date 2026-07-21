import type { AIProvider } from "./provider";
import {
  KNOWLEDGE_AI_JSON_SCHEMA,
  parseKnowledgeOutput,
  type KnowledgePair,
} from "./knowledge-schema";
import { redactChatText, hasResidualChatPii } from "./chat-redact";

/**
 * Pipeline สกัด "คู่ถาม-ตอบ" จากแชตกลุ่ม (Phase 1 — Reply Knowledge) — provider-agnostic + testable
 *
 *   [1] redact PII ทุกข้อความ (reuse chat-redact) → [2] residual-PII gate (fail-safe)
 *   → ยังมี PII หลุด: บล็อก ไม่ส่ง AI ภายนอก (blocked=true, ไม่มี pairs)
 *   → [3] build prompt (มีบทบาท ลูกค้า/ทีมงาน) → [4] provider.generateJson → [5] Zod validate (retry 1)
 *   → ไม่ผ่าน: parseFailed=true, ไม่มี pairs (ไม่เดา)
 *
 *   ★ ทำเฉพาะแชต "กลุ่ม" (group/room) — ไม่ยุ่ง 1-1/office และไม่ประเมินนักบัญชี
 *   ★ ไม่ยุ่ง DB — คืนคู่ Q&A พร้อมบันทึก (worker เข้ารหัส+เขียน DB); ไม่ log plaintext/ciphertext
 */

export type KnowledgeMessageContext = {
  /** ลำดับใน window (0-based) — AI อ้าง answer_msg_idx ด้วยเลขนี้ */
  idx: number;
  /** เวลา ISO ของข้อความ */
  at: string;
  /** บทบาทผู้ส่ง: customer|staff|other (staff = พนักงานที่ผูก employee_id) */
  role: "customer" | "staff" | "other";
  /** ข้อความดิบ (analyze จะ redact เอง) */
  text: string;
};

export type AnalyzeKnowledgeInput = {
  messages: KnowledgeMessageContext[];
  /** ชื่อที่ระบบรู้ (ลูกค้า/ธุรกิจ/พนักงาน/สมาชิกกลุ่ม) เพื่อ redact ตรงตัว */
  knownNames?: string[];
};

export type AnalyzeKnowledgeOutcome = {
  pairs: KnowledgePair[];
  provider: string;
  model: string;
  /** true เมื่อ parse/validate ไม่ผ่านทั้ง 2 ครั้ง */
  parseFailed: boolean;
  /** true เมื่อถูก residual-PII gate บล็อก (ไม่ได้ส่ง AI ภายนอก) */
  blocked: boolean;
};

/** ต้องมีอย่างน้อย 1 คำถามลูกค้า + 1 คำตอบพนักงาน ถึงจะมีคู่ให้สกัด */
function hasQuestionAndAnswer(msgs: KnowledgeMessageContext[]): boolean {
  return msgs.some((m) => m.role === "customer") && msgs.some((m) => m.role === "staff");
}

/** system prompt: สกัดคู่ถาม-ตอบเป็นความรู้ (แพตเทิร์นคำตอบของทีม) */
function buildKnowledgeSystemPrompt(): string {
  return [
    "คุณคือ 'น้อง NOVA' ผู้ช่วยสร้างคลังความรู้การตอบลูกค้าของสำนักงานบัญชี Finovas",
    "งานของคุณ: อ่านบทสนทนากลุ่ม LINE ระหว่างลูกค้ากับทีมงาน แล้วสกัด 'คู่ถาม-ตอบ' ที่มีประโยชน์",
    "เก็บไว้เป็นความรู้ให้ทีมเรียนรู้แนวทางการตอบ — ตอบเป็น JSON ตาม schema เท่านั้น",
    "",
    "★ เฟสนี้เก็บ+เรียนรู้เท่านั้น: คุณไม่ต้องตอบลูกค้า ไม่ต้องแต่งคำตอบใหม่",
    "  ให้สรุปสิ่งที่ 'ลูกค้าถาม' และ 'แนวทางที่ทีมงานตอบจริง' เท่านั้น",
    "",
    "กฎ:",
    "1. สกัดเฉพาะคู่ที่ 'ลูกค้าถาม/ขอ แล้วทีมงานตอบ/ช่วยเหลือ' จริงในบทสนทนา",
    "   ถ้าไม่มีคู่ถาม-ตอบชัดเจน ให้คืน pairs เป็น [] (อย่าเดา/อย่าแต่งขึ้นเอง)",
    "2. category: จัดหมวดเป็นภาษาไทยสั้น ๆ ตามเนื้อหา เช่น 'ภาษี','เอกสาร','ชำระเงิน','นัดหมาย','ทั่วไป'",
    "3. question_gist: สรุปคำถาม/สิ่งที่ลูกค้าต้องการ สั้น กระชับ เป็นกลาง (ห้ามใส่ชื่อ/เบอร์/ยอดเงิน/เลขที่ระบุตัวตน)",
    "4. answer_gist: สรุป 'แนวทาง/แพตเทิร์น' คำตอบของทีม ให้เป็นความรู้ทั่วไปที่นำไปใช้ซ้ำได้",
    "   ★ ห้ามคัดลอกข้อมูลเฉพาะลูกค้า (ตัวเลข/ชื่อ/วันเฉพาะราย) — ให้เป็นแนวทางกลาง",
    "5. answer_msg_idx: ระบุ msg_idx ของข้อความ 'ทีมงาน' ที่เป็นคำตอบหลักของคู่นี้ (ถ้าอ้างไม่ได้ให้ null)",
    "6. confidence: ความมั่นใจว่าเป็นคู่ถาม-ตอบจริง (0..1)",
    "7. ข้อความถูกปิดบัง PII ด้วย placeholder เช่น [ชื่อ] [เบอร์โทร] [เลข] [จำนวนเงิน] อยู่แล้ว — อย่าพยายามเดาค่าจริง",
  ].join("\n");
}

/** user prompt: บทสนทนา (redact แล้ว) พร้อมบทบาทผู้ส่ง */
function buildKnowledgeUserPrompt(messages: KnowledgeMessageContext[]): string {
  const roleLabel: Record<KnowledgeMessageContext["role"], string> = {
    customer: "ลูกค้า",
    staff: "ทีมงาน",
    other: "อื่นๆ",
  };
  const lines: string[] = [];
  lines.push("บทสนทนากลุ่ม (PII ถูกปิดบังด้วย placeholder แล้ว):");
  lines.push("รูปแบบ: [msg_idx] (เวลา) บทบาท: ข้อความ");
  lines.push("");
  for (const m of messages) {
    lines.push(`[${m.idx}] (${m.at}) ${roleLabel[m.role]}: ${m.text}`);
  }
  lines.push("");
  lines.push("โปรดสกัดคู่ถาม-ตอบที่ลูกค้าถามแล้วทีมงานตอบ และตอบเป็น JSON ตาม schema ที่กำหนด");
  return lines.join("\n");
}

export async function extractKnowledge(
  provider: AIProvider,
  input: AnalyzeKnowledgeInput
): Promise<AnalyzeKnowledgeOutcome> {
  const knownNames = input.knownNames ?? [];

  // [1] redact PII ทุกข้อความก่อนสร้าง prompt
  const redactedMessages: KnowledgeMessageContext[] = input.messages.map((m) => ({
    ...m,
    text: redactChatText(m.text, knownNames),
  }));

  // [1.5] ไม่มีทั้งคำถามลูกค้า+คำตอบทีมงาน → ไม่มีคู่ให้สกัด ไม่ต้องเรียก AI
  if (!hasQuestionAndAnswer(redactedMessages)) {
    return { pairs: [], provider: provider.name, model: provider.model, parseFailed: false, blocked: false };
  }

  // [2] residual-PII gate (fail-safe): ตรวจเฉพาะ "ค่า" ข้อความ — หลุด = ห้ามส่ง AI ภายนอก
  const joined = redactedMessages.map((m) => m.text).join(" ");
  if (hasResidualChatPii(joined)) {
    console.warn(
      "[ai/knowledge-extract] residual PII detected after redaction — blocking external AI call (no extraction)"
    );
    return { pairs: [], provider: provider.name, model: provider.model, parseFailed: true, blocked: true };
  }

  // [3] build prompt (ข้อความ redact แล้วเท่านั้น — ไม่ส่งชื่อ/PII ดิบเข้า AI)
  const system = buildKnowledgeSystemPrompt();
  const user = buildKnowledgeUserPrompt(redactedMessages);

  // [4]+[5] เรียก AI + validate; parse ไม่ผ่าน → retry 1 ครั้ง
  let parsed: KnowledgePair[] | null = null;
  for (let attempt = 0; attempt < 2 && parsed === null; attempt += 1) {
    try {
      const raw = await provider.generateJson({ system, user, jsonSchema: KNOWLEDGE_AI_JSON_SCHEMA });
      parsed = parseKnowledgeOutput(raw).pairs;
    } catch {
      parsed = null; // retry รอบถัดไป
    }
  }

  if (parsed === null) {
    return { pairs: [], provider: provider.name, model: provider.model, parseFailed: true, blocked: false };
  }

  return { pairs: parsed, provider: provider.name, model: provider.model, parseFailed: false, blocked: false };
}
