import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildPnd1Report, buildPnd1Workbook } from "@/lib/accounting/payroll-pnd1-export";
import type { Pnd1EmployeeTotal } from "@/lib/accounting/payroll-monthly-filing";

/**
 * เทสต์ lib/accounting/payroll-pnd1-export.ts (wishlist ข้อ 5 — ยื่น ภ.ง.ด.1)
 *   - buildPnd1Report: กรองพนักงานที่ไม่มีเงินได้ออก + รวมยอด
 *   - buildPnd1Workbook: สร้างไฟล์ Excel จริง อ่านกลับได้ (mirror pattern tests/accounting/rd-export.test.ts)
 */

function mkTotal(overrides: Partial<Pnd1EmployeeTotal> = {}): Pnd1EmployeeTotal {
  return {
    employeeId: "emp-1",
    employeeCode: "E001",
    fullName: "ทดสอบ นามสมมติ",
    idCardNo: "1234567890123",
    passportNo: null,
    grossIncome: 20000,
    pitWithheld: 100,
    ...overrides,
  };
}

describe("buildPnd1Report", () => {
  it("กรองพนักงานที่ grossIncome=0 ออก (ไม่มีอะไรต้องยื่นเดือนนี้)", () => {
    const r = buildPnd1Report([mkTotal(), mkTotal({ employeeId: "emp-2", grossIncome: 0, pitWithheld: 0 })]);
    expect(r.records).toHaveLength(1);
    expect(r.totals.count).toBe(1);
  });

  it("รวมยอด grossTotal/pitTotal ถูกต้อง", () => {
    const r = buildPnd1Report([
      mkTotal({ employeeId: "emp-1", grossIncome: 20000, pitWithheld: 100 }),
      mkTotal({ employeeId: "emp-2", grossIncome: 15000, pitWithheld: 50 }),
    ]);
    expect(r.totals.grossTotal).toBe(35000);
    expect(r.totals.pitTotal).toBe(150);
    expect(r.totals.count).toBe(2);
  });

  it("grossIncome=0 แต่ pitWithheld>0 (edge case ข้อมูลผิดปกติ) → ไม่ตัดออก ยังต้องยื่น", () => {
    const r = buildPnd1Report([mkTotal({ grossIncome: 0, pitWithheld: 50 })]);
    expect(r.records).toHaveLength(1);
    expect(r.totals.pitTotal).toBe(50);
  });

  it("array ว่าง → records/totals ว่างหมด ไม่ error", () => {
    const r = buildPnd1Report([]);
    expect(r.records).toEqual([]);
    expect(r.totals).toEqual({ count: 0, grossTotal: 0, pitTotal: 0 });
  });
});

describe("buildPnd1Workbook — สร้างไฟล์ Excel จริง", () => {
  it("Buffer อ่านกลับได้ + ชื่อชีท ภ.ง.ด.1 + มีแถวพนักงาน + แถวรวม", async () => {
    const report = buildPnd1Report([
      mkTotal({ employeeId: "emp-1", employeeCode: "E001", fullName: "สมชาย ใจดี", grossIncome: 20000, pitWithheld: 100 }),
      mkTotal({ employeeId: "emp-2", employeeCode: "E002", fullName: "สมหญิง มีสุข", grossIncome: 18000, pitWithheld: 80 }),
    ]);
    const buf = await buildPnd1Workbook(report, {
      entityLabel: "N001 · บริษัททดสอบ",
      periodLabel: "ส.ค. 2569",
      payerTaxId: "0105567064992",
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets.map((w) => w.name)).toContain("ภ.ง.ด.1");

    const ws = wb.getWorksheet("ภ.ง.ด.1")!;
    const allText = ws
      .getSheetValues()
      .flat()
      .filter((v): v is string => typeof v === "string")
      .join(" | ");
    expect(allText).toContain("0105567064992");
    expect(allText).toContain("N001 · บริษัททดสอบ");
    expect(allText).toContain("ส.ค. 2569");
    expect(allText).toContain("สมชาย ใจดี");
    expect(allText).toContain("รวมทั้งสิ้น");
  });

  it("ไม่มีเลขภาษีนายจ้าง (null) → โชว์ '-' ไม่ error", async () => {
    const report = buildPnd1Report([mkTotal()]);
    const buf = await buildPnd1Workbook(report, { entityLabel: "x", periodLabel: "y", payerTaxId: null });
    expect(Buffer.isBuffer(buf)).toBe(true);
  });
});
