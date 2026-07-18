import type { AIProvider } from "./provider";
import {
  CHAT_AI_JSON_SCHEMA,
  parseChatOutput,
  type ChatAnalysisResult,
  type ChatOutput,
} from "./chat-schema";
import {
  buildChatSystemPrompt,
  buildChatUserPrompt,
  type ChatConversationContext,
  type ChatMessageContext,
} from "./chat-prompt";
import { redactChatText, hasResidualChatPii } from "./chat-redact";
import { RISK_KEYWORDS } from "./guardrail";

/**
 * Pipeline วิเคราะห์บทสนทนากลุ่ม (Phase 2) — provider-agnostic + testable
 *
 *   [1] redact PII ทุกข้อความ (chat-redact) → [2] residual-PII gate (fail-safe)
 *   → ถ้ายังมี PII หลุด: บล็อก ไม่ส่ง AI ภายนอก + บังคับ human review
 *   → [3] build prompt → [4] provider.generateJson → [5] Zod validate (retry 1)
 *   → ไม่ผ่าน: fallback needs_human_review=true
 *   → [6] guardrail เบา: high/critical หรือ needs_expert_review → needs_human_review
 *
 * ไม่ยุ่ง DB — คืนผลพร้อมบันทึก (worker เขียน DB) และไม่ log plaintext/ciphertext
 */

export type AnalyzeChatInput = {
  /** ข้อความในหน้าต่างบทสนทนา (ดิบ ยังไม่ redact — analyze จะ redact เอง) */
  messages: ChatMessageContext[];
  groupLabel?: string | null;
  /** ชื่อที่ระบบรู้ว่าเป็น PII (ลูกค้า/ธุรกิจ/พนักงาน) เพื่อ redact ตรงตัว */
  knownNames?: string[];
};

export type AnalyzeChatOutcome = {
  result: ChatAnalysisResult;
  provider: string;
  model: string;
  violations: string[];
  /** true เมื่อ parse/validate ไม่ผ่านทั้ง 2 ครั้ง (ใช้ fallback) */
  parseFailed: boolean;
  /** true เมื่อถูก residual-PII gate บล็อก (ไม่ได้ส่ง AI ภายนอก) */
  blocked: boolean;
};

/** จำนวนข้อความขั้นต่ำที่พอจะวิเคราะห์ได้ — น้อยกว่านี้ = ข้อมูลไม่พอ */
const MIN_MESSAGES_FOR_ANALYSIS = 2;

/** ผลลัพธ์ fallback (ปลอดภัยไว้ก่อน — มนุษย์ตรวจ) */
function buildChatFallback(insufficient: boolean): ChatOutput {
  return {
    summary: insufficient
      ? "บทสนทนาสั้น/ข้อมูลไม่พอสรุป — รอเจ้าหน้าที่ตรวจสอบ"
      : "ระบบยังสรุปอัตโนมัติไม่สำเร็จ — รอเจ้าหน้าที่ตรวจสอบ",
    customer_facts: [],
    ai_assumptions: [],
    evidence: [],
    flow_steps: [],
    problems: [],
    sop_violations: [],
    sentiment_points: [],
    sentiment: "neutral",
    urgency: "medium",
    confidence: 0,
    insufficient_data: insufficient,
  };
}

/** นับ keyword เสี่ยง (บัญชี/ภาษี/กฎหมาย) ในสรุป+ข้อเท็จจริง — ใช้ประกอบ escalation */
function hasRiskKeyword(o: ChatOutput): boolean {
  const haystack = [o.summary, ...o.customer_facts, ...o.problems.map((p) => p.detail)]
    .join(" ")
    .toLowerCase();
  return RISK_KEYWORDS.some((k) => haystack.includes(k.toLowerCase()));
}

export async function analyzeChat(
  provider: AIProvider,
  input: AnalyzeChatInput
): Promise<AnalyzeChatOutcome> {
  const knownNames = input.knownNames ?? [];

  // [1] redact PII ทุกข้อความก่อนสร้าง prompt (hard requirement C-15)
  const redactedMessages: ChatMessageContext[] = input.messages.map((m) => ({
    ...m,
    text: redactChatText(m.text, knownNames),
  }));

  // [1.5] ข้อมูลไม่พอ (บทสนทนาสั้นเกินไป) → ไม่ต้องเรียก AI ภายนอก
  if (redactedMessages.length < MIN_MESSAGES_FOR_ANALYSIS) {
    return {
      result: {
        ...buildChatFallback(true),
        needs_human_review: false,
        validated: false,
      },
      provider: provider.name,
      model: provider.model,
      violations: ["insufficient_data (skipped AI)"],
      parseFailed: false,
      blocked: false,
    };
  }

  // [2] residual-PII gate (C-15 fail-safe): ตรวจเฉพาะ "ค่า" ข้อความที่ลูกค้าพิมพ์
  //   ถ้ายังพบ PII เด่น ๆ ตกค้าง → ห้ามส่ง AI ภายนอก (กัน PII รั่ว) บังคับมนุษย์ตรวจ
  const joined = redactedMessages.map((m) => m.text).join(" ");
  if (hasResidualChatPii(joined)) {
    console.warn(
      "[ai/chat-analyze] residual PII detected after redaction — blocking external AI call, forcing human review (C-15)"
    );
    const fb = buildChatFallback(false);
    fb.summary = "ตรวจพบข้อมูลส่วนบุคคลตกค้างหลัง redact — ระงับการส่ง AI ภายนอก รอเจ้าหน้าที่ตรวจ";
    return {
      result: { ...fb, needs_human_review: true, validated: false },
      provider: provider.name,
      model: provider.model,
      violations: ["residual_pii_blocked (C-15)"],
      parseFailed: true,
      blocked: true,
    };
  }

  // [3] build prompt (ใช้ข้อความที่ redact แล้วเท่านั้น)
  const ctx: ChatConversationContext = {
    groupLabel: input.groupLabel ?? null,
    messages: redactedMessages,
  };
  const system = buildChatSystemPrompt();
  const user = buildChatUserPrompt(ctx);

  // [4]+[5] เรียก AI + validate; parse ไม่ผ่าน → retry 1 ครั้ง
  let parsed: ChatOutput | null = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
    try {
      const raw = await provider.generateJson({ system, user, jsonSchema: CHAT_AI_JSON_SCHEMA });
      parsed = parseChatOutput(raw);
    } catch {
      parsed = null; // retry รอบถัดไป
    }
  }

  const validated = parsed !== null;
  let parseFailed = false;
  if (!parsed) {
    parsed = buildChatFallback(false);
    parseFailed = true;
  }

  // [6] guardrail เบา — บังคับ human review ตามเงื่อนไขเสี่ยง
  const violations: string[] = [];
  const highOrCritical = parsed.urgency === "high" || parsed.urgency === "critical";
  const anyExpertReview = parsed.sop_violations.some((v) => v.needs_expert_review);
  const riskEscalate = hasRiskKeyword(parsed) && parsed.sentiment === "negative";

  if (anyExpertReview) violations.push("expert_review_required (บัญชี/ภาษีเสี่ยงสูง)");
  if (riskEscalate) violations.push("risk_keyword + บริบทลบ");

  const needsHumanReview = highOrCritical || anyExpertReview || riskEscalate || !validated;

  const result: ChatAnalysisResult = {
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
