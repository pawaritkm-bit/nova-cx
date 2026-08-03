import { describe, it, expect } from "vitest";
import { normalizeCircle, normalizeShareCircles } from "@/lib/ai/share-circle";

describe("normalizeCircle — สกัด 1 วง (ระดับวง/เดือน)", () => {
  it("แปลงครบทุกช่อง (G/H/I/J/K + สมาชิก/ต้น/รอบ)", () => {
    const c = normalizeCircle({
      circle_name: "วงบิท",
      round_note: "รายเดือน",
      member_count: 21,
      principal_per_head: 100000,
      tao_income: 50000,
      mgmt_fee: 2000,
      operation_fee: 0,
      interest_income: 1500,
      expense: 300,
    });
    expect(c).not.toBeNull();
    expect(c!.circle_name).toBe("วงบิท");
    expect(c!.round_note).toBe("รายเดือน");
    expect(c!.member_count).toBe(21);
    expect(c!.principal_per_head).toBe(100000);
    expect(c!.tao_income).toBe(50000);
    expect(c!.operation_fee).toBe(0);
    expect(c!.interest_income).toBe(1500);
  });

  it("ตัดลูกน้ำหลักพันในตัวเลข (string) → เลขล้วน", () => {
    const c = normalizeCircle({ circle_name: "วง", tao_income: "100,000" });
    expect(c!.tao_income).toBe(100000);
  });

  it("ค่าติดลบ/ไม่ใช่เลข → null", () => {
    const c = normalizeCircle({ circle_name: "วง", tao_income: -5, mgmt_fee: "x" });
    expect(c!.tao_income).toBeNull();
    expect(c!.mgmt_fee).toBeNull();
  });

  it("ไม่มีชื่อวง แต่มีตัวเลข → ยังเก็บ (ชื่อ default)", () => {
    const c = normalizeCircle({ tao_income: 100 });
    expect(c).not.toBeNull();
    expect(c!.circle_name).toContain("วงแชร์");
  });

  it("ว่างเปล่า (ไม่มีชื่อ+ไม่มีตัวเลข) → null (ทิ้ง)", () => {
    expect(normalizeCircle({})).toBeNull();
    expect(normalizeCircle(null)).toBeNull();
    expect(normalizeCircle("x")).toBeNull();
  });
});

describe("normalizeShareCircles — จาก object ดิบของโมเดล", () => {
  it("ดึง circles[] + กรองวงว่างทิ้ง", () => {
    const rows = normalizeShareCircles({
      circles: [
        { circle_name: "วง A", tao_income: 100 },
        {}, // ว่าง → ทิ้ง
        { circle_name: "วง B", operation_fee: 0, tao_income: 200 },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.circle_name)).toEqual(["วง A", "วง B"]);
  });

  it("ไม่มี circles / null → []", () => {
    expect(normalizeShareCircles(null)).toEqual([]);
    expect(normalizeShareCircles({})).toEqual([]);
    expect(normalizeShareCircles({ circles: "x" as unknown as unknown[] })).toEqual([]);
  });

  it("cap 200 วง (กันผิดปกติ)", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ circle_name: `วง${i}`, tao_income: 1 }));
    expect(normalizeShareCircles({ circles: many })).toHaveLength(200);
  });
});
