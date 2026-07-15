import type { NormalizedQuestion } from "./types";

/**
 * Conditional logic ฝั่ง server (ต้องตรงกับที่ LIFF render — FR-SV-08)
 *   - follow-up ตามคะแนน: 4–5 = PRAISE, 3 = IMPROVE, 1–2 = ROOT_CAUSE(+ติดต่อกลับ)
 *   - "ยังไม่พบปัญหา"/exclusive option ต้องเลือกเดี่ยว (FR-SV-07)
 */

export type Followup = "PRAISE" | "IMPROVE" | "ROOT_CAUSE" | null;

/** คืน follow-up bucket ตามคะแนน rating (scale เริ่มต้น 5) */
export function ratingFollowup(value: number): Followup {
  if (!Number.isFinite(value)) return null;
  if (value >= 4) return "PRAISE";
  if (value === 3) return "IMPROVE";
  if (value <= 2) return "ROOT_CAUSE";
  return null;
}

/** true เมื่อ follow-up ควรเสนอ "ติดต่อกลับ" (คะแนนต่ำ 1–2) */
export function shouldOfferCallback(value: number): boolean {
  return ratingFollowup(value) === "ROOT_CAUSE";
}

/** ค่า option ที่เป็น exclusive (เลือกเดี่ยว) ของคำถาม multi หนึ่งข้อ */
export function exclusiveValues(question: NormalizedQuestion): string[] {
  return (question.options ?? [])
    .filter((o) => o.is_exclusive)
    .map((o) => o.value);
}

/**
 * ตรวจการเลือกแบบ multi:
 *   - ถ้ามี exclusive option ถูกเลือก ต้องเป็นค่าเดียวในลิสต์ (เช่น "ยังไม่พบปัญหา")
 * คืน true = ถูกต้อง
 */
export function validateExclusiveSelection(
  selected: string[],
  exclusive: string[]
): boolean {
  if (selected.length === 0) return true;
  const hasExclusive = selected.some((v) => exclusive.includes(v));
  if (!hasExclusive) return true;
  return selected.length === 1;
}

/**
 * ประเมินว่าคำถาม follow-up (ปลายเปิด) ข้อไหน "ต้องแสดง" ตามคำตอบ rating
 * คืน map: questionCode → Followup (เฉพาะข้อที่มี follow-up)
 * ใช้ทั้งฝั่ง render และ validate ให้ตรงกัน
 */
export function computeRatingFollowups(
  questions: NormalizedQuestion[],
  answers: Record<string, unknown>
): Record<string, Followup> {
  const result: Record<string, Followup> = {};
  for (const q of questions) {
    if (q.type !== "rating") continue;
    const raw = answers[q.code];
    const value = typeof raw === "number" ? raw : Number(raw);
    const fu = ratingFollowup(value);
    if (fu) result[q.code] = fu;
  }
  return result;
}
