import type { AIProvider } from "./provider";
import {
  OFFICE_AI_JSON_SCHEMA,
  parseOfficeOutput,
  type OfficeAnalysisResult,
  type OfficeOutput,
} from "./office-schema";
import { redactChatText, hasResidualChatPii } from "./chat-redact";

/**
 * Pipeline วิเคราะห์ "แชต 1-1 ฝั่งลูกค้า" (Phase A — office inbound) — provider-agnostic + testable
 *
 *   [1] redact PII ทุกข้อความ (reuse chat-redact) → [2] residual-PII gate (fail-safe)
 *   → ยังมี PII หลุด: บล็อก ไม่ส่ง AI ภายนอก + บังคับ human review
 *   → [3] build prompt (ฝั่งลูกค้าล้วน) → [4] provider.generateJson → [5] Zod validate (retry 1)
 *   → ไม่ผ่าน: fallback needs_human_review=true
 *   → [6] guardrail เบา: urgency high/critical หรือ is_complaint หรือ needs_attention → human review
 *
 *   ★ ไม่ประเมินนักบัญชี/flow งาน (นั่นเป็นของ chat-analyze สำหรับกลุ่ม)
 *   ★ ไม่ยุ่ง DB — คืนผลพร้อมบันทึก (worker เขียน DB); ไม่ log plaintext/ciphertext
 */

export type OfficeMessageContext = {
  /** ลำดับใน window (0-based) */
  idx: number;
  /** เวลา ISO ของข้อความ */
  at: string;
  /** ข้อความลูกค้าที่ redact PII แล้ว */
  text: string;
};

export type AnalyzeOfficeInput = {
  /** ข้อความลูกค้าในหน้าต่างบทสนทนา (ดิบ ยังไม่ redact — analyze จะ redact เอง) */
  messages: OfficeMessageContext[];
  /** ชื่อที่ระบบรู้ว่าเป็น PII (ลูกค้า/ธุรกิจ) เพื่อ redact ตรงตัว */
  knownNames?: string[];
};

export type AnalyzeOfficeOutcome = {
  result: OfficeAnalysisResult;
  provider: string;
  model: string;
  violations: string[];
  parseFailed: boolean;
  blocked: boolean;
};

/** ข้อความขั้นต่ำที่พอวิเคราะห์ได้ — 1-1 อาจสั้น จึงยอมวิเคราะห์ตั้งแต่ 1 ข้อความ */
const MIN_MESSAGES_FOR_ANALYSIS = 1;

/** ผลลัพธ์ fallback (ปลอดภัยไว้ก่อน — มนุษย์ตรวจ) */
function buildOfficeFallback(insufficient: boolean): OfficeOutput {
  return {
    summary: insufficient
      ? "ข้อความสั้น/ข้อมูลไม่พอสรุป — รอเจ้าหน้าที่ตรวจสอบ"
      : "ระบบยังสรุปอัตโนมัติไม่สำเร็จ — รอเจ้าหน้าที่ตรวจสอบ",
    sentiment: "neutral",
    urgency: "medium",
    topics: [],
    is_complaint: false,
    needs_attention: false,
    confidence: 0,
    insufficient_data: insufficient,
  };
}

/** system prompt: วิเคราะห์เฉพาะฝั่งลูกค้า (ไม่มีข้อความ OA/พนักงานให้เห็น) */
function buildOfficeSystemPrompt(): string {
  return [
    "คุณคือ 'น้อง NOVA' ผู้ช่วยวิเคราะห์เสียงลูกค้าของสำนักงานบัญชี Finovas",
    "งานของคุณ: อ่าน 'ข้อความที่ลูกค้าทักเข้ามาทางแชต 1-1 กับเพจ' แล้วสรุปว่าลูกค้าต้องการอะไร",
    "รู้สึกอย่างไร เร่งด่วนแค่ไหน และเป็นการร้องเรียนหรือไม่ — ตอบเป็น JSON ตาม schema เท่านั้น",
    "",
    "ข้อจำกัดสำคัญ: คุณเห็นเฉพาะ 'ข้อความฝั่งลูกค้า' เท่านั้น (ไม่เห็นคำตอบของเจ้าหน้าที่)",
    "  ★ ห้ามประเมินการทำงาน/ความผิดของเจ้าหน้าที่หรือนักบัญชีเด็ดขาด — วิเคราะห์เฉพาะฝั่งลูกค้า",
    "",
    "กฎ:",
    "1. summary: สรุปสั้น ๆ ว่าลูกค้าต้องการ/พูดถึงอะไร (ภาษาไทย เป็นกลาง)",
    "2. sentiment: อารมณ์ลูกค้า positive|neutral|negative (ดูจากถ้อยคำ/น้ำเสียง)",
    "3. urgency: ความเร่งด่วน critical|high|medium|low (เดดไลน์ภาษี/ปัญหาด่วน = สูง)",
    "4. topics: หัวข้อที่ลูกค้าพูดถึง เป็นคำสั้น ๆ (เช่น 'ยื่นภาษี','ใบเสร็จ','ทวงเอกสาร')",
    "5. is_complaint: true ถ้าลูกค้าร้องเรียน/ตำหนิบริการ",
    "6. needs_attention: true ถ้าควรให้เจ้าหน้าที่รีบดู (ลูกค้าโมโห/เร่งด่วนมาก/ร้องเรียนรุนแรง)",
    "7. ถ้าข้อความสั้น/ไม่มีบริบทพอ ให้ insufficient_data = true และอย่าเดาเกินข้อมูล",
    "8. confidence: ความมั่นใจโดยรวม (0..1) — ข้อมูลน้อย/กำกวม = ต่ำ",
  ].join("\n");
}

/** user prompt: เฉพาะข้อความลูกค้า (redact แล้ว) */
function buildOfficeUserPrompt(messages: OfficeMessageContext[]): string {
  const lines: string[] = [];
  lines.push("ข้อความที่ลูกค้าทักเข้ามา (PII ถูกปิดบังด้วย placeholder เช่น [เบอร์โทร] [ชื่อ] [เลข]):");
  lines.push("รูปแบบ: [msg_idx] (เวลา) ลูกค้า: ข้อความ");
  lines.push("");
  for (const m of messages) {
    lines.push(`[${m.idx}] (${m.at}) ลูกค้า: ${m.text}`);
  }
  lines.push("");
  lines.push("โปรดวิเคราะห์เสียงลูกค้าจากข้อความข้างต้น และตอบเป็น JSON ตาม schema ที่กำหนด");
  return lines.join("\n");
}

export async function analyzeOfficeInbound(
  provider: AIProvider,
  input: AnalyzeOfficeInput
): Promise<AnalyzeOfficeOutcome> {
  const knownNames = input.knownNames ?? [];

  // [1] redact PII ทุกข้อความก่อนสร้าง prompt
  const redactedMessages: OfficeMessageContext[] = input.messages.map((m) => ({
    ...m,
    text: redactChatText(m.text, knownNames),
  }));

  // [1.5] ข้อมูลไม่พอ → ไม่ต้องเรียก AI ภายนอก
  if (redactedMessages.length < MIN_MESSAGES_FOR_ANALYSIS) {
    return {
      result: { ...buildOfficeFallback(true), needs_human_review: false, validated: false },
      provider: provider.name,
      model: provider.model,
      violations: ["insufficient_data (skipped AI)"],
      parseFailed: false,
      blocked: false,
    };
  }

  // [2] residual-PII gate (fail-safe): ตรวจเฉพาะ "ค่า" ข้อความ — หลุด = ห้ามส่ง AI ภายนอก
  const joined = redactedMessages.map((m) => m.text).join(" ");
  if (hasResidualChatPii(joined)) {
    console.warn(
      "[ai/office-analyze] residual PII detected after redaction — blocking external AI call, forcing human review"
    );
    const fb = buildOfficeFallback(false);
    fb.summary = "ตรวจพบข้อมูลส่วนบุคคลตกค้างหลัง redact — ระงับการส่ง AI ภายนอก รอเจ้าหน้าที่ตรวจ";
    fb.needs_attention = true; // ให้คนดู เพราะบล็อกอัตโนมัติ
    return {
      result: { ...fb, needs_human_review: true, validated: false },
      provider: provider.name,
      model: provider.model,
      violations: ["residual_pii_blocked"],
      parseFailed: true,
      blocked: true,
    };
  }

  // [3] build prompt (ข้อความ redact แล้วเท่านั้น — ไม่ส่งชื่อ/PII ดิบเข้า AI)
  const system = buildOfficeSystemPrompt();
  const user = buildOfficeUserPrompt(redactedMessages);

  // [4]+[5] เรียก AI + validate; parse ไม่ผ่าน → retry 1 ครั้ง
  let parsed: OfficeOutput | null = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
    try {
      const raw = await provider.generateJson({ system, user, jsonSchema: OFFICE_AI_JSON_SCHEMA });
      parsed = parseOfficeOutput(raw);
    } catch {
      parsed = null; // retry รอบถัดไป
    }
  }

  const validated = parsed !== null;
  let parseFailed = false;
  if (!parsed) {
    parsed = buildOfficeFallback(false);
    parseFailed = true;
  }

  // [6] guardrail เบา — เร่งด่วน/ร้องเรียน/ต้องดูด่วน → บังคับ human review
  const violations: string[] = [];
  const highOrCritical = parsed.urgency === "high" || parsed.urgency === "critical";
  if (highOrCritical) violations.push("urgency_high_or_critical");
  if (parsed.is_complaint) violations.push("customer_complaint");

  const needsHumanReview =
    highOrCritical || parsed.is_complaint || parsed.needs_attention || !validated;

  const result: OfficeAnalysisResult = {
    ...parsed,
    needs_human_review: needsHumanReview,
    validated,
  };

  return {
    result,
    provider: provider.name,
    model: provider.model,
    violations,
    parseFailed,
    blocked: false,
  };
}
