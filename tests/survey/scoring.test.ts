import { describe, it, expect } from "vitest";
import { computeCsat, computeNps, npsCategory } from "@/lib/survey/scoring";
import type { NormalizedQuestion } from "@/lib/survey/types";

const questions: NormalizedQuestion[] = [
  { code: "r1", text: "", type: "rating", scale: 5 },
  { code: "r2", text: "", type: "rating", scale: 5 },
  { code: "r3", text: "", type: "rating", scale: 5 },
  { code: "nps", text: "", type: "nps" },
  { code: "note", text: "", type: "open" },
];

describe("survey/scoring — computeCsat", () => {
  it("เฉลี่ยเฉพาะ rating + มีคะแนนรายข้อ", () => {
    const r = computeCsat(questions, { r1: 5, r2: 4, r3: 3, note: "hi" });
    expect(r.count).toBe(3);
    expect(r.overall).toBe(4); // (5+4+3)/3
    expect(r.dimensions).toEqual([
      { dimension: "r1", score: 5 },
      { dimension: "r2", score: 4 },
      { dimension: "r3", score: 3 },
    ]);
  });
  it("ข้ามค่านอกช่วง 1..scale", () => {
    const r = computeCsat(questions, { r1: 5, r2: 0, r3: 9 });
    expect(r.count).toBe(1);
    expect(r.overall).toBe(5);
  });
  it("ไม่มี rating → overall null", () => {
    const r = computeCsat(questions, { note: "x" });
    expect(r.overall).toBeNull();
    expect(r.count).toBe(0);
  });
});

describe("survey/scoring — NPS", () => {
  it("จัดหมวดถูก", () => {
    expect(npsCategory(10)).toBe("promoter");
    expect(npsCategory(9)).toBe("promoter");
    expect(npsCategory(8)).toBe("passive");
    expect(npsCategory(7)).toBe("passive");
    expect(npsCategory(6)).toBe("detractor");
    expect(npsCategory(0)).toBe("detractor");
  });
  it("computeNps อ่านคำถาม type=nps", () => {
    expect(computeNps(questions, { nps: 9 })).toEqual({
      score: 9,
      category: "promoter",
    });
  });
  it("ค่านอกช่วง 0..10 → null", () => {
    expect(computeNps(questions, { nps: 11 })).toBeNull();
  });
  it("ไม่มีคำถาม nps → null", () => {
    const noNps: NormalizedQuestion[] = [{ code: "r1", text: "", type: "rating" }];
    expect(computeNps(noNps, { r1: 5 })).toBeNull();
  });
});
