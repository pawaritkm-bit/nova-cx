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

  // ★ บั๊ก P718: AI อ่าน "โปรไฟล์/เลขบัตร/วันเกิด" มาเป็นวง (ชื่อเป็นเลข + G/H/I/J/K ว่าง)
  it("garbage: ชื่อวงเป็นเลขบัตร 13 หลัก + ไม่มีเงินเลย → null (ทิ้ง)", () => {
    expect(normalizeCircle({ circle_name: "1103700623477" })).toBeNull();
  });
  it("garbage: ชื่อวงเป็นวันเกิด/รหัส (เลขล้วน ≥9 หลัก) + ไม่มีเงิน → null", () => {
    expect(normalizeCircle({ circle_name: "02112534" + "9" })).toBeNull(); // 9 หลัก
    expect(normalizeCircle({ circle_name: "021-119-9100" })).toBeNull(); // เบอร์ (strip ตัวคั่น)
  });
  it("เลขบัตรเป็นชื่อ แต่มีตัวเลขเงินจริง → คงไว้ (ไม่ทิ้ง เผื่อชื่อวงแปลก)", () => {
    const c = normalizeCircle({ circle_name: "1103700623477", tao_income: 5000 });
    expect(c).not.toBeNull();
    expect(c!.tao_income).toBe(5000);
  });
  it("วันเกิดสั้น (8 หลัก) ไม่เข้าเกณฑ์ garbage (≥9) → คงไว้", () => {
    // ปล่อยผ่าน (เกณฑ์ garbage คือ ≥9 หลัก) — ชื่อวงจริงบางวงอาจเป็นตัวเลขสั้น
    expect(normalizeCircle({ circle_name: "02112534" })).not.toBeNull();
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

  // ★ บั๊ก P718: AI คืนวงที่เป็นเลขบัตร/โปรไฟล์ทั้งหมด → ต้องกรองทิ้ง = []
  it("circles เป็นเลขบัตร/วันเกิดล้วน (garbage) → [] (ไม่สร้างวงมั่ว)", () => {
    const rows = normalizeShareCircles({
      circles: [
        { circle_name: "1103700623477" },
        { circle_name: "021123499" },
        { circle_name: "021119910" },
      ],
    });
    expect(rows).toEqual([]);
  });
  it("garbage ปนวงจริง → เก็บเฉพาะวงจริง", () => {
    const rows = normalizeShareCircles({
      circles: [
        { circle_name: "1103700623477" }, // garbage
        { circle_name: "วงบิท", tao_income: 50000 }, // จริง
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].circle_name).toBe("วงบิท");
  });
});
