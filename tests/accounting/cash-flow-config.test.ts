import { describe, it, expect } from "vitest";
import {
  CASH_POOL_STATIC_CODES,
  cashPoolCodesOf,
  isCashPoolCode,
  INVESTING_CODES,
  FINANCING_CODES,
  classifyCashFlowActivity,
} from "@/lib/accounting/cash-flow-config";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { TEST_CHART } from "@/tests/accounting/fixtures/chart";

/**
 * cash-flow-config.ts — เฟส 4 ส่วน O1 (docs/06-accounting-features-roadmap.md, หมวด 0.6/0.7)
 */

describe("cash-flow-config — cashPoolCodesOf (0.6)", () => {
  it("รวม CASH_POOL_STATIC_CODES (1010/1015) + รหัสธนาคารทั้งหมดที่ is_bank=true", () => {
    const codes = cashPoolCodesOf(TEST_CHART);
    expect([...codes].sort()).toEqual(["1010", "1015", "1020", "1025", "1030"]);
  });

  it("1160 (บัตรเครดิต) ไม่รวมใน cash pool", () => {
    expect(cashPoolCodesOf(TEST_CHART)).not.toContain("1160");
  });

  it("tenant เพิ่มบัญชีธนาคารเองมากกว่า 3 บัญชี → รวมครบทุกบัญชี (ไม่ hardcode 3 ตัว)", () => {
    const extendedChart: ChartAccount[] = [
      ...TEST_CHART,
      { code: "1035", name: "เงินฝากธนาคาร #4 (เพิ่มเอง)", category: "สินทรัพย์", bank: true },
      { code: "1040", name: "เงินฝากธนาคาร #5 (เพิ่มเอง)", category: "สินทรัพย์", bank: true },
    ];
    const codes = cashPoolCodesOf(extendedChart);
    expect([...codes].sort()).toEqual(["1010", "1015", "1020", "1025", "1030", "1035", "1040"]);
  });

  it("ผังว่าง → ยังคง CASH_POOL_STATIC_CODES เสมอ", () => {
    expect([...cashPoolCodesOf([])].sort()).toEqual([...CASH_POOL_STATIC_CODES].sort());
  });

  it("isCashPoolCode: จริงเฉพาะรหัสที่อยู่ใน pool", () => {
    expect(isCashPoolCode(TEST_CHART, "1010")).toBe(true);
    expect(isCashPoolCode(TEST_CHART, "1015")).toBe(true);
    expect(isCashPoolCode(TEST_CHART, "1020")).toBe(true);
    expect(isCashPoolCode(TEST_CHART, "1160")).toBe(false);
    expect(isCashPoolCode(TEST_CHART, "1140")).toBe(false);
    expect(isCashPoolCode(TEST_CHART, "9999")).toBe(false);
  });
});

describe("cash-flow-config — classifyCashFlowActivity (0.7)", () => {
  it("1010/1015 (เงินสด/เงินสดย่อย) — ไม่ควรถูกจัดกิจกรรมเอง (fallback operating เมื่อเรียกตรง ๆ)", () => {
    expect(classifyCashFlowActivity("1010")).toBe("operating");
    expect(classifyCashFlowActivity("1015")).toBe("operating");
  });

  it("1020-1030 (เงินฝากธนาคาร) → operating (fallback — ไม่ใช่ investing/financing)", () => {
    expect(classifyCashFlowActivity("1020")).toBe("operating");
    expect(classifyCashFlowActivity("1025")).toBe("operating");
    expect(classifyCashFlowActivity("1030")).toBe("operating");
  });

  it("AR/AP → operating (fallback)", () => {
    expect(classifyCashFlowActivity("1140")).toBe("operating"); // ลูกหนี้การค้า
    expect(classifyCashFlowActivity("2010")).toBe("operating"); // เจ้าหนี้การค้า
  });

  it("VAT/WHT → operating (fallback)", () => {
    expect(classifyCashFlowActivity("1154")).toBe("operating"); // ภาษีซื้อ
    expect(classifyCashFlowActivity("2900")).toBe("operating"); // ภาษีขาย
    expect(classifyCashFlowActivity("2910")).toBe("operating"); // ภาษีหัก ณ ที่จ่าย
    expect(classifyCashFlowActivity("1216")).toBe("operating"); // ภาษีถูกหัก ณ ที่จ่าย
  });

  it("16xx สินทรัพย์ถาวร (1610/1615/1640/1645) → investing", () => {
    for (const code of INVESTING_CODES) {
      expect(classifyCashFlowActivity(code)).toBe("investing");
    }
  });

  it("รหัสค่าเสื่อมสะสม (.1) ไม่รวมใน investing → fallback operating", () => {
    expect(classifyCashFlowActivity("1615.1")).toBe("operating");
    expect(classifyCashFlowActivity("1640.1")).toBe("operating");
    expect(classifyCashFlowActivity("1645.1")).toBe("operating");
  });

  it("3010/2110/2035 (ทุนเรือนหุ้น/หุ้นกู้/เงินปันผลค้างจ่าย) → financing", () => {
    for (const code of FINANCING_CODES) {
      expect(classifyCashFlowActivity(code)).toBe("financing");
    }
  });

  it("รายได้/ค่าใช้จ่ายทั้งหมด → operating (fallback)", () => {
    expect(classifyCashFlowActivity("4010")).toBe("operating"); // ขายสินค้า
    expect(classifyCashFlowActivity("5010")).toBe("operating"); // ซื้อสินค้า
    expect(classifyCashFlowActivity("5310")).toBe("operating"); // เงินเดือนพนักงาน
    expect(classifyCashFlowActivity("5370")).toBe("operating"); // ค่าเสื่อมราคา-อาคาร
  });

  it("รหัสอื่นนอกชุดทั้งหมด (tenant เพิ่มเอง) → operating (fallback ปลอดภัย, [⚠️ FLAG] 0.7)", () => {
    expect(classifyCashFlowActivity("9999")).toBe("operating");
    expect(classifyCashFlowActivity("2020")).toBe("operating"); // เงินกู้ยืมระยะยาวจากกรรมการ (สมมติ)
  });
});
