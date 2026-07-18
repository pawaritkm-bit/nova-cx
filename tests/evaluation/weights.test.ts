import { describe, it, expect } from "vitest";
import {
  DEFAULT_WEIGHTS,
  DIMENSIONS,
  validateWeights,
  normalizeWeights,
  weightsTotal,
  weightedOverall,
  clampScore,
} from "@/lib/evaluation/weights";

describe("weights — 8 มิติ + น้ำหนัก", () => {
  it("DEFAULT_WEIGHTS รวม = 100 และครบ 8 มิติ", () => {
    expect(DIMENSIONS).toHaveLength(8);
    expect(weightsTotal(DEFAULT_WEIGHTS)).toBe(100);
    expect(validateWeights(DEFAULT_WEIGHTS)).toBe(true);
  });

  it("validateWeights: รวมไม่ครบ 100 → false; ติดลบ → false", () => {
    expect(validateWeights({ ...DEFAULT_WEIGHTS, sla: 0 })).toBe(false);
    expect(validateWeights({ ...DEFAULT_WEIGHTS, sla: -15, ownership: 30 })).toBe(false);
  });

  it("normalizeWeights: ปรับสัดส่วนให้รวม = 100", () => {
    const n = normalizeWeights({
      correctness: 40,
      completeness: 20,
      sla: 30,
      clarity: 20,
      politeness: 20,
      ownership: 30,
      resolution: 20,
      sop: 20,
    });
    expect(weightsTotal(n)).toBeCloseTo(100, 5);
  });

  it("normalizeWeights: รวม = 0 → fallback DEFAULT", () => {
    expect(normalizeWeights({})).toEqual(DEFAULT_WEIGHTS);
  });

  it("clampScore: จำกัด 0-100 + กัน NaN", () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(150)).toBe(100);
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(73.2)).toBe(73.2);
  });

  it("weightedOverall: คะแนนเต็มทุกมิติ = 100", () => {
    const scores = Object.fromEntries(DIMENSIONS.map((d) => [d, 100]));
    expect(weightedOverall(scores as never)).toBe(100);
  });

  it("weightedOverall: ★ น้ำหนักมีผลจริง (sla ต่ำ + น้ำหนัก sla สูง = ดึง overall ลง)", () => {
    const scores = Object.fromEntries(DIMENSIONS.map((d) => [d, 100])) as Record<string, number>;
    scores.sla = 0;
    // ให้น้ำหนัก sla เยอะ → overall ต่ำลงชัด
    const heavy = weightedOverall(scores as never, {
      correctness: 10,
      completeness: 10,
      sla: 50,
      clarity: 5,
      politeness: 5,
      ownership: 5,
      resolution: 5,
      sop: 10,
    });
    const light = weightedOverall(scores as never, {
      correctness: 20,
      completeness: 20,
      sla: 5,
      clarity: 15,
      politeness: 15,
      ownership: 10,
      resolution: 10,
      sop: 5,
    });
    expect(heavy).toBeLessThan(light); // sla=0 ถ่วง overall มากขึ้นเมื่อ weight sla สูง
    expect(heavy).toBe(50); // 100*50% ที่เหลือ + 0*50% ของ sla
  });

  it("weightedOverall: มิติที่ไม่มีคะแนน (undefined) ไม่ถูกนับ (หารเฉพาะน้ำหนักที่มีคะแนน)", () => {
    // มีแค่ correctness = 80 → overall = 80 (ไม่ถูกมิติว่างดึงเป็น 0)
    expect(weightedOverall({ correctness: 80 })).toBe(80);
  });
});
