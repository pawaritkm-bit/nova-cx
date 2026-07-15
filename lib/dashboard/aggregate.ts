/**
 * ฟังก์ชันรวมคะแนน (aggregate) สำหรับ dashboard — บริสุทธิ์ ไม่แตะ DB
 *   - CSAT เฉลี่ย + n
 *   - NPS = %promoter - %detractor (มาตรฐาน NPS) + n
 *   - Response Rate = responded / invited
 *   - group by (ทีม/บริการ/รอบ) → ScoredItem[] พร้อม n (ต่อยอด sample-size rule)
 */

import type { ScoredItem } from "./sample-size";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------
// CSAT
// ---------------------------------------------------------------------
export type CsatAggregate = {
  /** ค่าเฉลี่ย CSAT (null = ไม่มีคะแนน) */
  avg: number | null;
  /** จำนวนตัวอย่าง (คำตอบที่มีคะแนน CSAT) */
  n: number;
};

/** เฉลี่ยค่า CSAT จากรายการคะแนน (ข้ามค่า null/ไม่ใช่ตัวเลข) */
export function computeCsat(scores: Array<number | null | undefined>): CsatAggregate {
  const valid = scores.filter(
    (s): s is number => typeof s === "number" && Number.isFinite(s)
  );
  if (valid.length === 0) return { avg: null, n: 0 };
  const sum = valid.reduce((a, b) => a + b, 0);
  return { avg: round2(sum / valid.length), n: valid.length };
}

// ---------------------------------------------------------------------
// NPS
// ---------------------------------------------------------------------
export type NpsCategory = "promoter" | "passive" | "detractor";

export type NpsAggregate = {
  /** ค่า NPS (-100..100) — null ถ้าไม่มีข้อมูล */
  nps: number | null;
  promoters: number;
  passives: number;
  detractors: number;
  n: number;
};

/** NPS = (%promoter - %detractor) จากหมวดที่จัดไว้แล้ว */
export function computeNps(
  categories: Array<NpsCategory | null | undefined>
): NpsAggregate {
  const valid = categories.filter(
    (c): c is NpsCategory =>
      c === "promoter" || c === "passive" || c === "detractor"
  );
  const n = valid.length;
  const promoters = valid.filter((c) => c === "promoter").length;
  const passives = valid.filter((c) => c === "passive").length;
  const detractors = valid.filter((c) => c === "detractor").length;
  if (n === 0) return { nps: null, promoters, passives, detractors, n };
  const nps = round2(((promoters - detractors) / n) * 100);
  return { nps, promoters, passives, detractors, n };
}

// ---------------------------------------------------------------------
// Response Rate
// ---------------------------------------------------------------------
export type ResponseRate = {
  invited: number;
  responded: number;
  /** อัตราตอบกลับ 0..1 (null ถ้าไม่มี invitation) */
  rate: number | null;
};

export function computeResponseRate(
  invited: number,
  responded: number
): ResponseRate {
  if (invited <= 0) return { invited, responded, rate: null };
  return { invited, responded, rate: round2(responded / invited) };
}

// ---------------------------------------------------------------------
// Group-by → ScoredItem[] (คะแนนเฉลี่ย + n ต่อกลุ่ม) สำหรับ sample-size rule
// ---------------------------------------------------------------------
/**
 * รวมคะแนนตาม key (เช่น ทีม/บริการ/รอบ) → ScoredItem[]
 *   getKey: ดึงป้ายกลุ่มจาก row (null/'' → ข้าม)
 *   getScore: ดึงคะแนนจาก row (null → ไม่นับใน n)
 */
export function groupScores<T>(
  rows: T[],
  getKey: (row: T) => string | null | undefined,
  getScore: (row: T) => number | null | undefined
): ScoredItem[] {
  const map = new Map<string, { sum: number; n: number }>();

  for (const row of rows) {
    const key = getKey(row);
    if (!key) continue;
    const score = getScore(row);
    const entry = map.get(key) ?? { sum: 0, n: 0 };
    if (typeof score === "number" && Number.isFinite(score)) {
      entry.sum += score;
      entry.n += 1;
    } else if (!map.has(key)) {
      // สร้าง entry ไว้ แม้ยังไม่มีคะแนน (กลุ่มมีอยู่จริงแต่ยังไม่มีคำตอบ)
    }
    map.set(key, entry);
  }

  return [...map.entries()].map(([label, { sum, n }]) => ({
    label,
    n,
    score: n > 0 ? round2(sum / n) : null,
  }));
}
