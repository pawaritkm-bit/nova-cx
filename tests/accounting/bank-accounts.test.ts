import { describe, it, expect } from "vitest";
import {
  BANK_ACCOUNT_CODES,
  isBankAccountCode,
  searchChartNonBank,
  BANK_ACCOUNTS,
  CHART_OF_ACCOUNTS,
} from "@/lib/accounting/chart-of-accounts";
import {
  clampBankText,
  bankAccountDisplayName,
  validateBankAccountInput,
  filterBankAccounts,
  BANK_NAME_MAX,
  ACCOUNT_NO_MAX,
  type CustomerBankAccount,
} from "@/lib/accounting/bank-accounts";

/**
 * เทสต์ helper pure ของฟีเจอร์ "บัญชีธนาคารต่อลูกค้า":
 *   1) ผังกลาง genericize — บัญชีเงินฝาก 1020/1025/1030 เป็น bank + ชื่อ generic
 *   2) validate accountCode (ต้องเป็นรหัสเงินฝาก) + sanitize ชื่อ/เลข
 *   3) merge/filter ตัวเลือก picker (บัญชีลูกค้า + ผังกลางที่ตัดหมวดเงินฝาก)
 */

describe("chart-of-accounts — genericize หมวดเงินฝาก (bank:true)", () => {
  it("BANK_ACCOUNT_CODES = 1020/1025/1030 (คำนวณจาก bank:true)", () => {
    expect([...BANK_ACCOUNT_CODES].sort()).toEqual(["1020", "1025", "1030"]);
  });

  it("ชื่อบัญชีเงินฝากเป็น generic ไม่มีเลขบัญชีจริง (กัน PDPA)", () => {
    for (const code of BANK_ACCOUNT_CODES) {
      const acct = CHART_OF_ACCOUNTS.find((a) => a.code === code)!;
      expect(acct.bank).toBe(true);
      expect(acct.name).toMatch(/^เงินฝากธนาคาร #\d$/);
      // ไม่มีเลขบัญชีจริงหลงเหลือ (เช่น 210-1-77368-2)
      expect(acct.name).not.toMatch(/\d{3}-\d/);
    }
  });

  it("isBankAccountCode: จริงเฉพาะรหัสเงินฝาก", () => {
    expect(isBankAccountCode("1020")).toBe(true);
    expect(isBankAccountCode("1030")).toBe(true);
    expect(isBankAccountCode("1010")).toBe(false); // เงินสด
    expect(isBankAccountCode("5010")).toBe(false);
    expect(isBankAccountCode("")).toBe(false);
    expect(isBankAccountCode("9999")).toBe(false);
  });

  it("searchChartNonBank: ตัดหมวดเงินฝาก (bank:true) ออกทั้งหมด", () => {
    const all = searchChartNonBank("");
    expect(all.some((a) => a.bank)).toBe(false);
    // 1010 เงินสด ยังอยู่ · 1020 เงินฝาก ต้องหาย
    expect(all.some((a) => a.code === "1010")).toBe(true);
    expect(all.some((a) => a.code === "1020")).toBe(false);
    expect(all.length).toBe(CHART_OF_ACCOUNTS.length - BANK_ACCOUNTS.length);
  });

  it("searchChartNonBank: ค้น 'เงินฝาก' ไม่คืน generic bank (ตัดออกแล้ว)", () => {
    const r = searchChartNonBank("เงินฝากธนาคาร");
    expect(r.some((a) => a.bank)).toBe(false);
    // ยังเจอ 4210 ดอกเบี้ยเงินฝากธนาคาร (ไม่ใช่ bank)
    expect(r.some((a) => a.code === "4210")).toBe(true);
  });
});

describe("bank-accounts — clampBankText", () => {
  it("trim + clamp ความยาว · ว่าง → null", () => {
    expect(clampBankText("  กสิกรไทย  ", BANK_NAME_MAX)).toBe("กสิกรไทย");
    expect(clampBankText("", BANK_NAME_MAX)).toBeNull();
    expect(clampBankText("   ", BANK_NAME_MAX)).toBeNull();
    expect(clampBankText(null, BANK_NAME_MAX)).toBeNull();
    expect(clampBankText(123 as unknown, BANK_NAME_MAX)).toBeNull();
    expect(clampBankText("x".repeat(200), ACCOUNT_NO_MAX)?.length).toBe(ACCOUNT_NO_MAX);
  });
});

describe("bank-accounts — bankAccountDisplayName", () => {
  it("รวมชื่อธนาคาร + เลขบัญชี (ตัดช่องว่างซ้อน)", () => {
    expect(bankAccountDisplayName({ bankName: "กสิกรไทย", accountNo: "210-1-77368-2" })).toBe(
      "กสิกรไทย 210-1-77368-2"
    );
    expect(bankAccountDisplayName({ bankName: "กสิกร", accountNo: null })).toBe("กสิกร");
    expect(bankAccountDisplayName({ bankName: null, accountNo: "123" })).toBe("123");
  });

  it("ไม่มีข้อมูลเลย → fallback 'เงินฝากธนาคาร'", () => {
    expect(bankAccountDisplayName({ bankName: null, accountNo: null })).toBe("เงินฝากธนาคาร");
    expect(bankAccountDisplayName({})).toBe("เงินฝากธนาคาร");
  });
});

describe("bank-accounts — validateBankAccountInput", () => {
  it("accountCode ไม่ใช่รหัสเงินฝาก → null (ปฏิเสธ)", () => {
    expect(validateBankAccountInput({ accountCode: "1010" })).toBeNull(); // เงินสด
    expect(validateBankAccountInput({ accountCode: "9999" })).toBeNull();
    expect(validateBankAccountInput({ accountCode: "" })).toBeNull();
    expect(validateBankAccountInput({ accountCode: 1020 as unknown })).toBeNull();
  });

  it("รหัสเงินฝากถูก → คืนค่าที่ sanitize แล้ว", () => {
    const v = validateBankAccountInput({
      accountCode: "  1020  ",
      bankName: "  กสิกรไทย  ",
      accountNo: "210-1-77368-2",
    });
    expect(v).toEqual({
      accountCode: "1020",
      bankName: "กสิกรไทย",
      accountNo: "210-1-77368-2",
    });
  });

  it("ชื่อ/เลขว่าง → null (ไม่บังคับ)", () => {
    const v = validateBankAccountInput({ accountCode: "1025", bankName: "", accountNo: "   " });
    expect(v).toEqual({ accountCode: "1025", bankName: null, accountNo: null });
  });

  it("clamp ความยาวชื่อ/เลข", () => {
    const v = validateBankAccountInput({
      accountCode: "1030",
      bankName: "ก".repeat(200),
      accountNo: "1".repeat(200),
    });
    expect(v?.bankName?.length).toBe(BANK_NAME_MAX);
    expect(v?.accountNo?.length).toBe(ACCOUNT_NO_MAX);
  });
});

describe("bank-accounts — filterBankAccounts (picker)", () => {
  const list: CustomerBankAccount[] = [
    { id: "a", accountCode: "1020", bankName: "กสิกรไทย", accountNo: "210-1-77368-2" },
    { id: "b", accountCode: "1025", bankName: "ไทยพาณิชย์", accountNo: "555-2-99999-0" },
    { id: "c", accountCode: "1030", bankName: null, accountNo: null },
  ];

  it("q ว่าง → คืนทั้งหมด", () => {
    expect(filterBankAccounts(list, "")).toHaveLength(3);
    expect(filterBankAccounts(list, "  ")).toHaveLength(3);
  });

  it("ค้นด้วยรหัส / ชื่อธนาคาร / เลขบัญชี", () => {
    expect(filterBankAccounts(list, "1025").map((b) => b.id)).toEqual(["b"]);
    expect(filterBankAccounts(list, "กสิกร").map((b) => b.id)).toEqual(["a"]);
    expect(filterBankAccounts(list, "555").map((b) => b.id)).toEqual(["b"]);
    expect(filterBankAccounts(list, "ไม่มี")).toHaveLength(0);
  });

  it("row ที่ไม่มีชื่อ/เลข ไม่พังตอนค้น", () => {
    expect(filterBankAccounts(list, "1030").map((b) => b.id)).toEqual(["c"]);
  });
});
