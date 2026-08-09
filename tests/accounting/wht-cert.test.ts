import { describe, it, expect } from "vitest";
import {
  isWhtCertEligible,
  buildWhtCertLines,
  WHT_INCOME_TYPE_OPTIONS,
  type WhtCertSourceLine,
} from "@/lib/accounting/wht-cert";

/**
 * เฟส 3 ส่วน I (I5) — isWhtCertEligible ทุก branch + buildWhtCertLines กรอง whtAmount>0
 */

function whtLine(p: Partial<WhtCertSourceLine>): WhtCertSourceLine {
  return {
    description: "ค่าบริการ",
    amount: 1000,
    whtRate: 3,
    whtAmount: 30,
    ...p,
  };
}

describe("isWhtCertEligible", () => {
  it("บิลซื้อ มีบรรทัด wht > 0 → true", () => {
    expect(
      isWhtCertEligible({
        entryType: "purchase",
        lines: [{ whtAmount: 30 }, { whtAmount: 0 }],
      })
    ).toBe(true);
  });

  it("บิลซื้อ ไม่มีบรรทัด wht เลย (ทุกบรรทัด = 0) → false", () => {
    expect(
      isWhtCertEligible({
        entryType: "purchase",
        lines: [{ whtAmount: 0 }, { whtAmount: 0 }],
      })
    ).toBe(false);
  });

  it("บิลซื้อ ไม่มีบรรทัดเลย → false", () => {
    expect(isWhtCertEligible({ entryType: "purchase", lines: [] })).toBe(false);
  });

  it("บิลขาย มี wht > 0 → false (ลูกค้าเราเป็นผู้ถูกหัก ไม่ใช่ผู้ออกใบรับรอง)", () => {
    expect(
      isWhtCertEligible({
        entryType: "sale",
        lines: [{ whtAmount: 30 }],
      })
    ).toBe(false);
  });

  it("บิล unspecified มี wht > 0 → false", () => {
    expect(
      isWhtCertEligible({
        entryType: "unspecified",
        lines: [{ whtAmount: 30 }],
      })
    ).toBe(false);
  });
});

describe("buildWhtCertLines", () => {
  it("กรองเฉพาะบรรทัด whtAmount > 0 — บรรทัดที่ wht=0 ต้องไม่ติดมา", () => {
    const lines: WhtCertSourceLine[] = [
      whtLine({ description: "ค่าบริการ A", amount: 1000, whtRate: 3, whtAmount: 30 }),
      whtLine({ description: "ไม่มี wht", amount: 500, whtRate: 0, whtAmount: 0 }),
      whtLine({ description: "ค่าเช่า B", amount: 2000, whtRate: 5, whtAmount: 100 }),
    ];
    const result = buildWhtCertLines(lines, "01/08/2569");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      date: "01/08/2569",
      description: "ค่าบริการ A",
      amount: 1000,
      whtRate: 3,
      whtAmount: 30,
    });
    expect(result[1]).toEqual({
      date: "01/08/2569",
      description: "ค่าเช่า B",
      amount: 2000,
      whtRate: 5,
      whtAmount: 100,
    });
  });

  it("บิลเดียวมีหลายบรรทัด wht พร้อมกัน → คงทุกบรรทัดไว้ในเอกสารเดียว (ไม่แยกเอกสารต่อบรรทัด)", () => {
    const lines: WhtCertSourceLine[] = [
      whtLine({ description: "L1", amount: 100, whtRate: 3, whtAmount: 3 }),
      whtLine({ description: "L2", amount: 200, whtRate: 3, whtAmount: 6 }),
      whtLine({ description: "L3", amount: 300, whtRate: 5, whtAmount: 15 }),
    ];
    const result = buildWhtCertLines(lines, "15/07/2569");
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.description)).toEqual(["L1", "L2", "L3"]);
    expect(result.every((r) => r.date === "15/07/2569")).toBe(true);
  });

  it("ไม่มีบรรทัด wht เลย → คืน array ว่าง", () => {
    const lines: WhtCertSourceLine[] = [whtLine({ whtAmount: 0 }), whtLine({ whtAmount: 0 })];
    expect(buildWhtCertLines(lines)).toEqual([]);
  });

  it("ไม่ส่ง docDate มา → default เป็นสตริงว่าง", () => {
    const result = buildWhtCertLines([whtLine({ whtAmount: 30 })]);
    expect(result[0].date).toBe("");
  });

  it("description เป็น null → คืนสตริงว่าง (ไม่พัง)", () => {
    const result = buildWhtCertLines([whtLine({ description: null, whtAmount: 30 })]);
    expect(result[0].description).toBe("");
  });
});

describe("WHT_INCOME_TYPE_OPTIONS", () => {
  it("มีตัวเลือกครบตามสเปก (ค่าจ้าง/บริการ, เช่า, ขนส่ง, โฆษณา, รางวัล/ส่วนลด/ของแถม, อื่นๆ)", () => {
    expect(WHT_INCOME_TYPE_OPTIONS.length).toBeGreaterThanOrEqual(6);
    for (const o of WHT_INCOME_TYPE_OPTIONS) {
      expect(typeof o.value).toBe("string");
      expect(o.value.length).toBeGreaterThan(0);
      expect(typeof o.label).toBe("string");
      expect(o.label.length).toBeGreaterThan(0);
    }
    // ไม่มีค่าซ้ำ
    const values = WHT_INCOME_TYPE_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
