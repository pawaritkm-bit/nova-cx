import type { AIProvider } from "./provider";
import { AI_JSON_SCHEMA, parseAiOutput, type AiAnalysisResult, type AiOutput } from "./schema";
import { buildSystemPrompt, buildUserPrompt, type SurveyContext } from "./prompt";
import { redactDeep, hasResidualPii, collectStringValues } from "./redact";
import { applyGuardrails } from "./guardrail";

/**
 * Pipeline วิเคราะห์ความคิดเห็น (น้อง NOVA) — provider-agnostic + testable
 *
 *   [1] redact PII จาก answers (C-15)  → [2] build prompt (persona+guardrail)
 *   → [3] provider.generateJson (structured JSON) → [4] Zod validate
 *   → ไม่ผ่าน: retry 1 ครั้ง → ยังไม่ผ่าน: fallback needs_human_review=true
 *   → [5] guardrail post-filter (C-01..C-04)
 *
 * ไม่ยุ่งกับ DB — คืนผลลัพธ์พร้อมบันทึก (worker เป็นคนเขียน DB)
 */

export type AnalyzeInput = SurveyContext & {
  /** ชื่อที่ระบบรู้ว่าเป็น PII (ลูกค้า/ธุรกิจ/พนักงาน) เพื่อ redact แบบตรงตัว */
  knownNames?: string[];
};

export type AnalyzeOutcome = {
  result: AiAnalysisResult;
  provider: string;
  model: string;
  /** รายการ guardrail violation (log/debug) */
  violations: string[];
  /** true เมื่อ parse/validate ไม่ผ่านทั้ง 2 ครั้ง (ใช้ fallback) */
  parseFailed: boolean;
};

/** ผลลัพธ์ fallback เมื่อ AI parse ไม่ผ่าน — ปลอดภัยไว้ก่อน (มนุษย์ตรวจ) */
function buildFallback(): AiOutput {
  return {
    summary: "ระบบยังสรุปอัตโนมัติไม่สำเร็จ — รอเจ้าหน้าที่ตรวจสอบ",
    customer_facts: [],
    ai_assumptions: [],
    evidence: [],
    categories: [],
    sentiment: "neutral",
    urgency: "medium",
    urgency_reason: "AI ประมวลผลไม่สำเร็จ จึงตั้งเป็น medium เพื่อให้มนุษย์ตรวจ",
    affected: { employee: null, team: null, service: null, period: null },
    repeat_issue: false,
    next_best_action: "มอบหมายเจ้าหน้าที่อ่านคำตอบและสรุปด้วยตนเอง",
    draft_reply: "",
    confidence: 0,
  };
}

export async function analyzeFeedback(
  provider: AIProvider,
  input: AnalyzeInput
): Promise<AnalyzeOutcome> {
  const { knownNames = [], ...ctx } = input;

  // [1] redact PII ใน answers ก่อนสร้าง prompt (hard requirement C-15)
  const redactedAnswers = redactDeep(ctx.answers, knownNames) as Record<string, unknown>;
  const safeCtx: SurveyContext = { ...ctx, answers: redactedAnswers };

  // [1.5] residual-PII gate (C-15 fail-safe): ถ้ายังพบ PII เด่นๆ ตกค้างหลัง redact
  //   → ห้ามส่งออก external AI (กัน PII รั่ว), บังคับมนุษย์ตรวจ, ไม่คืน draft_reply
  //   ตรวจเฉพาะ "ค่า" ที่ลูกค้าพิมพ์ (leaf string values) ไม่รวม key เพราะ key เป็น
  //   question_code/employee_id (UUID) ที่ระบบสร้างเอง — UUID มีเลข 13 หลักไป match
  //   regex เลขภาษี ทำให้บล็อกผิด (false positive) ทุก Form B
  if (hasResidualPii(collectStringValues(redactedAnswers).join(" "))) {
    console.warn(
      "[ai/analyze] residual PII detected after redaction — blocking external AI call, forcing human review (C-15)"
    );
    const fb = buildFallback();
    fb.summary = "ตรวจพบข้อมูลส่วนบุคคลตกค้างหลัง redact — ระงับการส่ง AI ภายนอก รอเจ้าหน้าที่ตรวจ";
    fb.draft_reply = "";
    return {
      result: {
        ...fb,
        draft_reply: "",
        needs_human_review: true,
        validated: false,
      },
      provider: provider.name,
      model: provider.model,
      violations: ["residual_pii_blocked (C-15)"],
      parseFailed: true,
    };
  }

  // [2] build prompt
  const system = buildSystemPrompt();
  const user = buildUserPrompt(safeCtx);

  // [3]+[4] เรียก AI + validate; parse ไม่ผ่าน → retry 1 ครั้ง
  let parsed: AiOutput | null = null;
  let parseFailed = false;
  for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
    try {
      const raw = await provider.generateJson({ system, user, jsonSchema: AI_JSON_SCHEMA });
      parsed = parseAiOutput(raw);
    } catch {
      parsed = null; // ลอง retry รอบถัดไป
    }
  }

  const validated = parsed !== null;
  if (!parsed) {
    parsed = buildFallback();
    parseFailed = true;
  }

  // [5] guardrail post-filter (C-01..C-04)
  const guard = applyGuardrails(parsed);

  // High/Critical → บังคับ needs_human_review (FR-AI-04) + parse fail → true
  const highOrCritical = guard.output.urgency === "high" || guard.output.urgency === "critical";
  const needsHumanReview = guard.needsHumanReview || highOrCritical || !validated;

  const result: AiAnalysisResult = {
    ...guard.output,
    needs_human_review: needsHumanReview,
    validated,
  };

  return {
    result,
    provider: provider.name,
    model: provider.model,
    violations: guard.violations,
    parseFailed,
  };
}
