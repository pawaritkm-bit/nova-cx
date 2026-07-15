/**
 * กฎ Sample Size (FR-DB-04, C-11)
 *   - แสดงคะแนนพร้อมจำนวนตัวอย่าง (n) เสมอ
 *   - ถ้า n น้อยกว่าเกณฑ์ (default 5) ห้ามสรุป "ดีสุด/แย่สุด" หรือจัดอันดับชี้ขาด
 *   - ฟังก์ชันบริสุทธิ์ (ไม่แตะ DB) เพื่อ unit test ได้ทันที
 */

/** จำนวนตัวอย่างขั้นต่ำก่อนจะสรุปเชิงเปรียบเทียบได้ (business rule) */
export const SAMPLE_SIZE_MIN = 5;

/** n เพียงพอต่อการสรุปเชิงเปรียบเทียบหรือไม่ */
export function isSufficientSample(
  n: number,
  min: number = SAMPLE_SIZE_MIN
): boolean {
  return Number.isFinite(n) && n >= min;
}

/** ป้ายกำกับความน่าเชื่อถือของคะแนน (ใช้แสดงข้าง n บน dashboard) */
export function sampleReliability(
  n: number,
  min: number = SAMPLE_SIZE_MIN
): "insufficient" | "ok" {
  return isSufficientSample(n, min) ? "ok" : "insufficient";
}

export type ScoredItem = {
  /** ป้ายชื่อ (ทีม/บริการ/พนักงาน) */
  label: string;
  /** คะแนนเฉลี่ย (null = ยังไม่มีคะแนน) */
  score: number | null;
  /** จำนวนตัวอย่าง */
  n: number;
};

export type BestWorstResult = {
  /** สรุปได้หรือไม่ (n ทุกตัวเข้าเกณฑ์ + มีอย่างน้อย 2 กลุ่มที่มีคะแนน) */
  canRank: boolean;
  /** เหตุผลเมื่อสรุปไม่ได้ (ไว้แสดงผู้ใช้) */
  reason?: string;
  best: ScoredItem | null;
  worst: ScoredItem | null;
};

/**
 * เลือก "ดีสุด/แย่สุด" อย่างระมัดระวัง:
 *   - พิจารณาเฉพาะกลุ่มที่มีคะแนน (score != null)
 *   - ถ้ามีกลุ่มใดที่ n < min → ไม่สรุป (คืน canRank=false + reason)
 *   - ต้องมีอย่างน้อย 2 กลุ่มถึงจะบอก "ดีสุด/แย่สุด" ได้อย่างมีความหมาย
 * ป้องกันการใช้คะแนนจากตัวอย่างน้อยตัดสินผลงาน (C-11)
 */
export function pickBestWorst(
  items: ScoredItem[],
  min: number = SAMPLE_SIZE_MIN
): BestWorstResult {
  const scored = items.filter(
    (it): it is ScoredItem & { score: number } => it.score !== null
  );

  if (scored.length < 2) {
    return {
      canRank: false,
      reason: "มีกลุ่มที่มีคะแนนไม่ถึง 2 กลุ่ม — ยังไม่สรุปดีสุด/แย่สุด",
      best: null,
      worst: null,
    };
  }

  const lowSample = scored.filter((it) => !isSufficientSample(it.n, min));
  if (lowSample.length > 0) {
    const names = lowSample.map((it) => it.label).join(", ");
    return {
      canRank: false,
      reason: `ตัวอย่างน้อย (n < ${min}) ที่: ${names} — ยังไม่สรุปดีสุด/แย่สุด`,
      best: null,
      worst: null,
    };
  }

  const sorted = [...scored].sort((a, b) => b.score - a.score);
  return {
    canRank: true,
    best: sorted[0],
    worst: sorted[sorted.length - 1],
  };
}
