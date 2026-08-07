import { describe, it, expect } from "vitest";
import {
  parseOpeningBalanceRows,
  parseMoney,
  sumOpeningBalances,
  clampOpeningText,
  ACCOUNT_CODE_MAX,
} from "@/lib/accounting/opening-balance";
import { customerInScope, type AccountingAccess } from "@/lib/accounting/access";

/**
 * เทสต์ helper pure ของ "ยอดยกมาต่อบัญชี":
 *   1) parseMoney: comma / วงเล็บติดลบ / เลขไทย
 *   2) parseOpeningBalanceRows: จับคอลัมน์ยืดหยุ่น (ไทย/อังกฤษ) + validate
 *   3) guard scope: customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 */

describe("opening-balance — parseMoney", () => {
  it("เลขปกติ / comma / ทศนิยม", () => {
    expect(parseMoney("1234.5")).toBe(1234.5);
    expect(parseMoney("1,234.50")).toBe(1234.5);
    expect(parseMoney(1000)).toBe(1000);
    expect(parseMoney("  2,000  ")).toBe(2000);
  });

  it("วงเล็บ = ติดลบ (บัญชี)", () => {
    expect(parseMoney("(1,234)")).toBe(-1234);
    expect(parseMoney("-500")).toBe(-500);
  });

  it("เลขไทย → อารบิก", () => {
    expect(parseMoney("๑,๒๓๔.๕๐")).toBe(1234.5);
  });

  it("ค่าพัง → 0", () => {
    expect(parseMoney("")).toBe(0);
    expect(parseMoney("abc")).toBe(0);
    expect(parseMoney(null)).toBe(0);
  });
});

describe("opening-balance — parseOpeningBalanceRows (จับคอลัมน์)", () => {
  it("หัวคอลัมน์ไทย (รหัสบัญชี / ชื่อบัญชี / ยอดยกมาต้นงวด)", () => {
    const grid = [
      ["รหัสบัญชี", "ชื่อบัญชี", "ยอดยกมาต้นงวด"],
      ["1010", "เงินสด", "5,000"],
      ["2010", "เจ้าหนี้การค้า", "(3,000)"],
    ];
    const rows = parseOpeningBalanceRows(grid);
    expect(rows).toEqual([
      { accountCode: "1010", accountName: "เงินสด", openingBalance: 5000 },
      { accountCode: "2010", accountName: "เจ้าหนี้การค้า", openingBalance: -3000 },
    ]);
  });

  it("หัวคอลัมน์อังกฤษ (code / name / opening)", () => {
    const grid = [
      ["code", "name", "opening"],
      ["1140", "ลูกหนี้", "12000"],
    ];
    const rows = parseOpeningBalanceRows(grid);
    expect(rows).toEqual([{ accountCode: "1140", accountName: "ลูกหนี้", openingBalance: 12000 }]);
  });

  it("ไม่มีคอลัมน์ชื่อ → เติมชื่อจากผังกลางถ้ารหัสอยู่ในผัง", () => {
    const grid = [
      ["รหัสบัญชี", "ยอดยกมา"],
      ["1010", "1000"],
      ["9999", "500"], // นอกผัง → ชื่อ null
    ];
    const rows = parseOpeningBalanceRows(grid);
    expect(rows[0]).toEqual({ accountCode: "1010", accountName: "เงินสด", openingBalance: 1000 });
    expect(rows[1]).toEqual({ accountCode: "9999", accountName: null, openingBalance: 500 });
  });

  it("ข้ามแถวรหัสว่าง + แถวรวม", () => {
    const grid = [
      ["รหัสบัญชี", "ยอดยกมา"],
      ["1010", "1000"],
      ["", "999"],
      ["รวม", "1000"],
      ["total", "1000"],
    ];
    const rows = parseOpeningBalanceRows(grid);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountCode).toBe("1010");
  });

  it("มีแถวอื่นก่อน header (title) → หา header เจอ", () => {
    const grid = [
      ["รายงานยอดยกมา บริษัท ABC"],
      [],
      ["รหัสบัญชี", "ชื่อบัญชี", "ยอดยกมา"],
      ["1010", "เงินสด", "100"],
    ];
    const rows = parseOpeningBalanceRows(grid);
    expect(rows).toEqual([{ accountCode: "1010", accountName: "เงินสด", openingBalance: 100 }]);
  });

  it("ไม่พบ header ที่จำเป็น → []", () => {
    const grid = [
      ["ก", "ข", "ค"],
      ["1", "2", "3"],
    ];
    expect(parseOpeningBalanceRows(grid)).toEqual([]);
    expect(parseOpeningBalanceRows([])).toEqual([]);
  });

  it("รหัสซ้ำในไฟล์ → แถวหลังทับก่อน", () => {
    const grid = [
      ["รหัสบัญชี", "ยอดยกมา"],
      ["1010", "100"],
      ["1010", "200"],
    ];
    const rows = parseOpeningBalanceRows(grid);
    expect(rows).toHaveLength(1);
    expect(rows[0].openingBalance).toBe(200);
  });
});

describe("opening-balance — sumOpeningBalances + clampOpeningText", () => {
  it("รวมยอด (เดบิต+ / เครดิต-)", () => {
    expect(
      sumOpeningBalances([{ openingBalance: 5000 }, { openingBalance: -3000 }, { openingBalance: -2000 }])
    ).toBe(0);
  });

  it("clamp ความยาว + trim", () => {
    expect(clampOpeningText("  1010  ", ACCOUNT_CODE_MAX)).toBe("1010");
    expect(clampOpeningText("", ACCOUNT_CODE_MAX)).toBeNull();
    expect(clampOpeningText("x".repeat(50), ACCOUNT_CODE_MAX)?.length).toBe(ACCOUNT_CODE_MAX);
  });
});

describe("opening-balance — guard scope (customerInScope)", () => {
  const accountant: AccountingAccess = {
    tenantId: "t1",
    mode: "accountant",
    employeeId: "e1",
    name: "นักบัญชี",
    allowedCustomerIds: new Set(["c1", "c2"]),
    navRole: "accountant",
  };
  const admin: AccountingAccess = {
    tenantId: "t1",
    mode: "admin",
    employeeId: null,
    name: null,
    allowedCustomerIds: null,
    navRole: "admin",
  };

  it("นักบัญชี: จัดการยอดยกมาได้เฉพาะลูกค้าที่ดูแล", () => {
    expect(customerInScope(accountant, "c1")).toBe(true);
    expect(customerInScope(accountant, "c9")).toBe(false); // ลูกค้าคนอื่น
    expect(customerInScope(accountant, null)).toBe(false); // ไม่ผูกลูกค้า
  });

  it("admin: เห็นทุกลูกค้า", () => {
    expect(customerInScope(admin, "c1")).toBe(true);
    expect(customerInScope(admin, "c9")).toBe(true);
  });
});
