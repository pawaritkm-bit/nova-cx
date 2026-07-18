/**
 * น้ำหนัก 8 มิติของการประเมินนักบัญชี (Phase 4) — ★ ฟังก์ชันบริสุทธิ์ (ไม่แตะ DB)
 *   - DIMENSIONS : รายชื่อ 8 มิติ (ตรงกับ dimension_scores/evaluation_weights ใน 0035)
 *   - DEFAULT_WEIGHTS : ค่าเริ่มต้น (รวม = 100)
 *   - validateWeights / normalizeWeights : กัน misconfig (รวมไม่เท่า 100)
 *   - weightedOverall : รวมคะแนน 8 มิติด้วยน้ำหนัก → overall 0-100
 *
 * ★ เชิงปริมาณ (คำนวณจาก signal จริง): sla, resolution, ownership
 *   เชิงคุณภาพ (จาก AI): correctness, completeness, clarity, politeness
 *   กึ่งปริมาณ (จากผลวิเคราะห์): sop (นับ/severity ของ sop_violations)
 */

/** 8 มิติ (คงลำดับให้ตรงกับ SQL helper eval_weight_total) */
export const DIMENSIONS = [
  "correctness", // ความถูกต้องของคำตอบ (AI)
  "completeness", // ความครบถ้วน (AI)
  "sla", // ตอบ/ปิดตรงเวลา (signal)
  "clarity", // ความชัดเจน/เข้าใจง่าย (AI)
  "politeness", // ความสุภาพ/ใส่ใจ (AI)
  "ownership", // ความเป็นเจ้าของงาน/ติดตาม (signal)
  "resolution", // ปิดงานได้จริง (signal)
  "sop", // ทำตามมาตรฐาน (จาก sop_violations)
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/** มิติเชิงคุณภาพที่ให้ AI ประเมิน */
export const QUALITATIVE_DIMENSIONS: readonly Dimension[] = [
  "correctness",
  "completeness",
  "clarity",
  "politeness",
] as const;

/** มิติเชิงปริมาณที่คำนวณจาก signal จริง (+ sop กึ่งปริมาณ) */
export const QUANTITATIVE_DIMENSIONS: readonly Dimension[] = [
  "sla",
  "ownership",
  "resolution",
  "sop",
] as const;

export type DimensionScores = Record<Dimension, number>;
export type Weights = Record<Dimension, number>;

/** น้ำหนักเริ่มต้น (รวม = 100) — ตรงกับ default ใน migration 0035 */
export const DEFAULT_WEIGHTS: Weights = {
  correctness: 20,
  completeness: 10,
  sla: 15,
  clarity: 10,
  politeness: 10,
  ownership: 15,
  resolution: 10,
  sop: 10,
};

/** ผลรวมน้ำหนักทั้ง 8 มิติ */
export function weightsTotal(w: Partial<Weights>): number {
  return DIMENSIONS.reduce((sum, d) => sum + (Number(w[d]) || 0), 0);
}

/** true เมื่อรวม = 100 (±0.01 กัน float) และทุกค่าไม่ติดลบ */
export function validateWeights(w: Partial<Weights>): boolean {
  if (DIMENSIONS.some((d) => (Number(w[d]) || 0) < 0)) return false;
  return Math.abs(weightsTotal(w) - 100) < 0.01;
}

/**
 * แปลงชุดน้ำหนักใด ๆ ให้รวม = 100 (สัดส่วนเดิม)
 *   - รับ partial / ไม่ครบ → เติมมิติที่ขาดเป็น 0
 *   - รวม = 0 (ไม่มีน้ำหนักเลย) → fallback DEFAULT_WEIGHTS
 */
export function normalizeWeights(w: Partial<Weights>): Weights {
  const total = weightsTotal(w);
  if (total <= 0) return { ...DEFAULT_WEIGHTS };
  const out = {} as Weights;
  for (const d of DIMENSIONS) {
    out[d] = ((Number(w[d]) || 0) / total) * 100;
  }
  return out;
}

/** clamp คะแนน 1 มิติให้อยู่ 0-100 (กันค่าเพี้ยนจาก AI/สูตร) */
export function clampScore(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

/**
 * รวมคะแนน 8 มิติด้วยน้ำหนัก → overall 0-100 (ปัดทศนิยม 2 ตำแหน่ง)
 *   - normalize น้ำหนักก่อน (กัน misconfig รวมไม่ครบ 100)
 *   - มิติที่ไม่มีคะแนน (undefined) → ไม่นับ + หารด้วยน้ำหนักที่ "มีคะแนนจริง"
 *     (ช่วงข้อมูลบางมิติว่าง เช่น ไม่มีเคสให้วัด sla → ไม่ดึง overall ให้ต่ำเกินจริง)
 */
export function weightedOverall(
  scores: Partial<DimensionScores>,
  weights: Partial<Weights> = DEFAULT_WEIGHTS
): number {
  const w = normalizeWeights(weights);
  let acc = 0;
  let usedWeight = 0;
  for (const d of DIMENSIONS) {
    const s = scores[d];
    if (s === undefined || s === null || !Number.isFinite(s)) continue;
    acc += clampScore(s) * w[d];
    usedWeight += w[d];
  }
  if (usedWeight <= 0) return 0;
  const overall = acc / usedWeight;
  return Math.round(overall * 100) / 100;
}
