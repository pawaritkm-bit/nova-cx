import { describe, it, expect } from "vitest";
import {
  computeCsat,
  computeNps,
  computeResponseRate,
  groupScores,
} from "@/lib/dashboard/aggregate";

describe("aggregate — CSAT", () => {
  it("เฉลี่ย + นับ n (ข้าม null)", () => {
    const r = computeCsat([5, 4, null, 3, undefined]);
    expect(r.avg).toBe(4);
    expect(r.n).toBe(3);
  });
  it("ไม่มีคะแนน → avg null, n 0", () => {
    expect(computeCsat([null, undefined])).toEqual({ avg: null, n: 0 });
  });
});

describe("aggregate — NPS = %promoter - %detractor", () => {
  it("คำนวณถูกต้อง", () => {
    // 6 promoter, 2 passive, 2 detractor => (60-20)=40
    const cats = [
      ...Array(6).fill("promoter"),
      ...Array(2).fill("passive"),
      ...Array(2).fill("detractor"),
    ];
    const r = computeNps(cats as ("promoter" | "passive" | "detractor")[]);
    expect(r.nps).toBe(40);
    expect(r.n).toBe(10);
    expect(r.promoters).toBe(6);
    expect(r.detractors).toBe(2);
  });
  it("ไม่มีข้อมูล → null", () => {
    expect(computeNps([]).nps).toBeNull();
  });
});

describe("aggregate — Response Rate", () => {
  it("responded/invited", () => {
    expect(computeResponseRate(10, 4).rate).toBe(0.4);
  });
  it("invited=0 → null (กันหารศูนย์)", () => {
    expect(computeResponseRate(0, 0).rate).toBeNull();
  });
});

describe("aggregate — groupScores", () => {
  it("รวมคะแนนตาม key + n ต่อกลุ่ม", () => {
    const rows = [
      { team: "A", score: 5 },
      { team: "A", score: 3 },
      { team: "B", score: 4 },
      { team: "B", score: null },
      { team: null, score: 5 }, // key ว่าง → ข้าม
    ];
    const items = groupScores(
      rows,
      (r) => r.team,
      (r) => r.score
    );
    const a = items.find((i) => i.label === "A")!;
    const b = items.find((i) => i.label === "B")!;
    expect(a).toEqual({ label: "A", score: 4, n: 2 });
    // B มี 1 คะแนน + 1 null → n=1
    expect(b.n).toBe(1);
    expect(b.score).toBe(4);
    expect(items.find((i) => i.label === "null")).toBeUndefined();
  });
});
