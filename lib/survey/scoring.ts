import type { NormalizedQuestion } from "./types";

/**
 * คำนวณ CSAT / NPS เบื้องต้นจากคำตอบ (FR-SV-10)
 *   - CSAT: ค่าเฉลี่ยคำถาม type=rating (scale 5) + คะแนนแยกรายข้อ (dimension)
 *   - NPS:  คำถาม type=nps (0–10) → หมวด promoter/passive/detractor
 * ฟังก์ชันบริสุทธิ์ (ไม่แตะ DB) เพื่อ unit test ได้ทันที
 */

export type CsatResult = {
  overall: number | null; // ค่าเฉลี่ยรวม (ปัด 2 ตำแหน่ง) — null ถ้าไม่มี rating
  count: number;
  dimensions: { dimension: string; score: number }[]; // คะแนนรายข้อ
};

export type NpsCategory = "promoter" | "passive" | "detractor";
export type NpsResult = { score: number; category: NpsCategory } | null;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** ดึงค่า rating เป็น number ที่ valid (1..scale) หรือ null */
function ratingValue(raw: unknown, scale: number): number | null {
  const v = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(v)) return null;
  if (v < 1 || v > scale) return null;
  return v;
}

export function computeCsat(
  questions: NormalizedQuestion[],
  answers: Record<string, unknown>
): CsatResult {
  const dimensions: { dimension: string; score: number }[] = [];
  let sum = 0;
  let count = 0;

  for (const q of questions) {
    if (q.type !== "rating") continue;
    const scale = q.scale ?? 5;
    const v = ratingValue(answers[q.code], scale);
    if (v === null) continue;
    dimensions.push({ dimension: q.code, score: v });
    sum += v;
    count += 1;
  }

  return {
    overall: count > 0 ? round2(sum / count) : null,
    count,
    dimensions,
  };
}

export function npsCategory(score: number): NpsCategory {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

export function computeNps(
  questions: NormalizedQuestion[],
  answers: Record<string, unknown>
): NpsResult {
  const npsQ = questions.find((q) => q.type === "nps");
  if (!npsQ) return null;
  const raw = answers[npsQ.code];
  const v = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 10) return null;
  return { score: v, category: npsCategory(v) };
}
