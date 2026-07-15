import { describe, it, expect } from "vitest";
import {
  SAMPLE_SIZE_MIN,
  isSufficientSample,
  sampleReliability,
  pickBestWorst,
  type ScoredItem,
} from "@/lib/dashboard/sample-size";

describe("sample-size rule (FR-DB-04, C-11)", () => {
  it("เกณฑ์ขั้นต่ำ default = 5", () => {
    expect(SAMPLE_SIZE_MIN).toBe(5);
    expect(isSufficientSample(5)).toBe(true);
    expect(isSufficientSample(4)).toBe(false);
    expect(isSufficientSample(0)).toBe(false);
  });

  it("sampleReliability บอก ok/insufficient", () => {
    expect(sampleReliability(10)).toBe("ok");
    expect(sampleReliability(2)).toBe("insufficient");
  });

  it("pickBestWorst: จัดอันดับได้เมื่อทุกกลุ่ม n เพียงพอ", () => {
    const items: ScoredItem[] = [
      { label: "A", score: 4.5, n: 10 },
      { label: "B", score: 3.2, n: 8 },
      { label: "C", score: 4.9, n: 6 },
    ];
    const r = pickBestWorst(items);
    expect(r.canRank).toBe(true);
    expect(r.best?.label).toBe("C");
    expect(r.worst?.label).toBe("B");
  });

  it("pickBestWorst: ไม่สรุปเมื่อมีกลุ่ม n น้อย (< min)", () => {
    const items: ScoredItem[] = [
      { label: "A", score: 4.5, n: 10 },
      { label: "B", score: 3.2, n: 3 }, // ตัวอย่างน้อย
    ];
    const r = pickBestWorst(items);
    expect(r.canRank).toBe(false);
    expect(r.best).toBeNull();
    expect(r.worst).toBeNull();
    expect(r.reason).toContain("B");
  });

  it("pickBestWorst: ไม่สรุปเมื่อมีน้อยกว่า 2 กลุ่มที่มีคะแนน", () => {
    const items: ScoredItem[] = [
      { label: "A", score: 4.5, n: 10 },
      { label: "B", score: null, n: 0 },
    ];
    const r = pickBestWorst(items);
    expect(r.canRank).toBe(false);
  });

  it("ข้ามกลุ่มที่ยังไม่มีคะแนน (score=null) ในการจัดอันดับ", () => {
    const items: ScoredItem[] = [
      { label: "A", score: 4.0, n: 6 },
      { label: "B", score: 3.0, n: 7 },
      { label: "C", score: null, n: 0 },
    ];
    const r = pickBestWorst(items);
    expect(r.canRank).toBe(true);
    expect(r.best?.label).toBe("A");
    expect(r.worst?.label).toBe("B");
  });
});
