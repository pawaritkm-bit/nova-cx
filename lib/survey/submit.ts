import { z } from "zod";
import type { NormalizedQuestion } from "./types";
import { buildQuestionMap } from "./schema";
import { exclusiveValues, validateExclusiveSelection } from "./conditional";

/**
 * Zod schema ของ payload submit + validate คำตอบเทียบ template ฝั่ง server
 * (กัน client bypass — conditional/exclusive/ช่วงคะแนน ต้องเช็คซ้ำที่ server)
 */

/** ค่าคำตอบที่รับได้: ตัวเลข (rating/nps), สตริง (single/open), อาเรย์สตริง (multi), null */
const answerValueSchema = z.union([
  z.number(),
  z.string(),
  z.array(z.string()),
  z.boolean(),
  z.null(),
]);

export const submitPayloadSchema = z.object({
  token: z.string().min(10, "token ไม่ถูกต้อง"),
  /** LINE userId ของผู้ตอบ (จาก LIFF) — ใช้ตรวจเจ้าของ invitation */
  lineUserId: z.string().optional(),
  /** consent PDPA ขั้นต่ำ (บังคับก่อนบันทึก) */
  consent: z.boolean().optional(),
  /** คำตอบ: map question_code → value */
  answers: z.record(answerValueSchema),
});

export type SubmitPayload = z.infer<typeof submitPayloadSchema>;

export type ValidationError = { code: string; message: string };

/**
 * คำถามที่ "บังคับตอบ" (FR-SC-04c บังคับประเมิน)
 *   - default: ทุกคำถาม rating + nps ต้องตอบ
 *   - เว้นได้ถ้า schema ระบุ optional === true (เผื่ออนาคต)
 */
export function requiredQuestionCodes(
  questions: NormalizedQuestion[]
): string[] {
  return questions
    .filter(
      (q) =>
        (q.type === "rating" || q.type === "nps") &&
        (q as { optional?: boolean }).optional !== true
    )
    .map((q) => q.code);
}

/** true เมื่อค่าถือว่า "ตอบแล้ว" (ไม่ว่าง) */
export function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * validate คำตอบเทียบกับคำถามใน template
 *   - rating: ต้องเป็นตัวเลข 1..scale
 *   - nps: 0..10
 *   - multi: exclusive option ต้องเลือกเดี่ยว (FR-SV-07)
 *   - single: ค่าต้องอยู่ในตัวเลือก (ถ้ามี options)
 *   - required: คำถามบังคับต้องมีคำตอบไม่ว่าง (ถ้าส่ง requiredCodes มา)
 * คำตอบ code ที่ไม่อยู่ใน template (เช่น follow-up ปลายเปิด) อนุญาตให้ผ่าน
 */
export function validateAnswers(
  questions: NormalizedQuestion[],
  answers: Record<string, unknown>,
  requiredCodes?: string[]
): { ok: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const map = buildQuestionMap(questions);

  // ตรวจคำถามบังคับตอบก่อน
  for (const code of requiredCodes ?? []) {
    if (!isAnswered(answers[code])) {
      errors.push({ code, message: "กรุณาตอบคำถามนี้" });
    }
  }

  for (const [code, value] of Object.entries(answers)) {
    const q = map.get(code);
    if (!q) continue; // follow-up / ปลายเปิดที่ไม่ normalize — ปล่อยผ่าน

    if (value === null || value === undefined) continue;

    switch (q.type) {
      case "rating": {
        const scale = q.scale ?? 5;
        const v = typeof value === "number" ? value : Number(value);
        if (!Number.isInteger(v) || v < 1 || v > scale) {
          errors.push({
            code,
            message: `คะแนนต้องเป็นจำนวนเต็ม 1–${scale}`,
          });
        }
        break;
      }
      case "nps": {
        const v = typeof value === "number" ? value : Number(value);
        if (!Number.isInteger(v) || v < 0 || v > 10) {
          errors.push({ code, message: "NPS ต้องเป็น 0–10" });
        }
        break;
      }
      case "multi": {
        const arr = Array.isArray(value) ? value.map(String) : [String(value)];
        const exclusive = exclusiveValues(q);
        if (!validateExclusiveSelection(arr, exclusive)) {
          errors.push({
            code,
            message: 'ตัวเลือก "ยังไม่พบปัญหา/ไม่มีปัญหา" ต้องเลือกแบบเดี่ยว',
          });
        }
        if (q.options && q.options.length > 0) {
          const allowed = new Set(q.options.map((o) => o.value));
          for (const v of arr) {
            if (!allowed.has(v)) {
              errors.push({ code, message: `ตัวเลือกไม่ถูกต้อง: ${v}` });
            }
          }
        }
        break;
      }
      case "single": {
        if (q.options && q.options.length > 0) {
          const allowed = new Set(q.options.map((o) => o.value));
          if (!allowed.has(String(value))) {
            errors.push({
              code,
              message: `ตัวเลือกไม่ถูกต้อง: ${String(value)}`,
            });
          }
        }
        break;
      }
      case "open":
      default:
        break;
    }
  }

  return { ok: errors.length === 0, errors };
}

/** แปลง answers map → แถวสำหรับ insert survey_answers (append-only) */
export function toAnswerRows(
  answers: Record<string, unknown>
): { question_code: string; value_json: unknown }[] {
  return Object.entries(answers).map(([question_code, value]) => ({
    question_code,
    value_json: value ?? null,
  }));
}
