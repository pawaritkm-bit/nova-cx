import { describe, it, expect, beforeEach } from "vitest";
import { makeInMemoryDb, type Tables } from "../helpers/fake-payroll-db";
import { TEST_CHART } from "./fixtures/chart";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import {
  validatePayrollSettingsInput,
  getOrCreateDefaultSettings,
  upsertSettings,
  getSettings,
  type PayrollSettingsInput,
} from "@/lib/accounting/payroll-settings";

/**
 * เทสต์ lib/accounting/payroll-settings.ts (เฟส 9 ส่วน AC, T105, 0.11)
 *   ★ ผังทดสอบเพิ่ม 2050/5311 (seed migration 0084) นอกเหนือจาก TEST_CHART เดิม (mirror 0063)
 */
const PAYROLL_CHART = [
  ...TEST_CHART,
  { code: "2050", name: "เงินสมทบประกันสังคมค้างนำส่ง", category: "หนี้สิน" },
  { code: "5311", name: "เงินสมทบประกันสังคม (ส่วนนายจ้าง)", category: "ค่าใช้จ่าย" },
];
const chartByCode = buildChartByCode(PAYROLL_CHART);

const TENANT = "tenant-1";
const CUSTOMER_A = "cust-a";

function validInput(p: Partial<PayrollSettingsInput> = {}): PayrollSettingsInput {
  return {
    salaryExpenseAccountCode: "5310",
    ssoEmployerExpenseAccountCode: "5311",
    ssoPayableAccountCode: "2050",
    pitPayableAccountCode: "2910",
    ...p,
  };
}

describe("validatePayrollSettingsInput (0.11)", () => {
  it("input ถูกต้องครบถ้วน → ผ่าน", () => {
    const res = validatePayrollSettingsInput(validInput(), chartByCode);
    expect(res.ok).toBe(true);
  });

  it("★ salary_expense_account_code ไม่ใช่หมวดค่าใช้จ่าย → ปฏิเสธ", () => {
    const res = validatePayrollSettingsInput(validInput({ salaryExpenseAccountCode: "2910" }), chartByCode);
    expect(res.ok).toBe(false);
  });

  it("★ sso_employer_expense_account_code ไม่ใช่หมวดค่าใช้จ่าย → ปฏิเสธ", () => {
    const res = validatePayrollSettingsInput(validInput({ ssoEmployerExpenseAccountCode: "2050" }), chartByCode);
    expect(res.ok).toBe(false);
  });

  it("★ pit_payable_account_code ไม่ใช่หมวดหนี้สิน → ปฏิเสธ", () => {
    const res = validatePayrollSettingsInput(validInput({ pitPayableAccountCode: "5310" }), chartByCode);
    expect(res.ok).toBe(false);
  });

  it("★ sso_payable_account_code ไม่ใช่หมวดหนี้สิน → ปฏิเสธ", () => {
    const res = validatePayrollSettingsInput(validInput({ ssoPayableAccountCode: "5310" }), chartByCode);
    expect(res.ok).toBe(false);
  });

  it("รหัสบัญชีไม่อยู่ในผัง → ปฏิเสธ", () => {
    const res = validatePayrollSettingsInput(validInput({ salaryExpenseAccountCode: "9999-ไม่มีจริง" }), chartByCode);
    expect(res.ok).toBe(false);
  });

  it("other_deductions_account_code ไม่กรอก → ผ่าน (nullable)", () => {
    const res = validatePayrollSettingsInput(validInput(), chartByCode);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.otherDeductionsAccountCode).toBeNull();
  });

  it("other_deductions_account_code กรอกแต่ไม่ใช่หมวดหนี้สิน → ปฏิเสธ", () => {
    const res = validatePayrollSettingsInput(validInput({ otherDeductionsAccountCode: "5310" }), chartByCode);
    expect(res.ok).toBe(false);
  });

  it("net_pay_account_code กรอกเป็นหมวดสินทรัพย์ (เงินสด/ธนาคาร — โอนทันที) → ผ่าน", () => {
    const res = validatePayrollSettingsInput(validInput({ netPayAccountCode: "1010" }), chartByCode);
    expect(res.ok).toBe(true);
  });

  it("net_pay_account_code กรอกเป็นหมวดที่ไม่ใช่หนี้สิน/สินทรัพย์ → ปฏิเสธ", () => {
    const res = validatePayrollSettingsInput(validInput({ netPayAccountCode: "4010" }), chartByCode);
    expect(res.ok).toBe(false);
  });
});

describe("data layer", () => {
  let tables: Tables;
  beforeEach(() => {
    tables = { payroll_settings: [] };
  });

  it("getOrCreateDefaultSettings — ลูกค้าใหม่ที่ยังไม่มีแถว → คืนค่าแนะนำ 4 ช่องถูกต้อง + 2 ช่องที่เหลือเป็น null", async () => {
    const { db } = makeInMemoryDb(tables);
    const settings = await getOrCreateDefaultSettings(db, TENANT, CUSTOMER_A);
    expect(settings.salaryExpenseAccountCode).toBe("5310");
    expect(settings.ssoEmployerExpenseAccountCode).toBe("5311");
    expect(settings.ssoPayableAccountCode).toBe("2050");
    expect(settings.pitPayableAccountCode).toBe("2910");
    expect(settings.otherDeductionsAccountCode).toBeNull();
    expect(settings.netPayAccountCode).toBeNull();
  });

  it("getOrCreateDefaultSettings — เรียกซ้ำ → คืนแถวเดิม ไม่สร้างซ้ำ", async () => {
    const { db } = makeInMemoryDb(tables);
    await getOrCreateDefaultSettings(db, TENANT, CUSTOMER_A);
    await getOrCreateDefaultSettings(db, TENANT, CUSTOMER_A);
    expect(tables.payroll_settings).toHaveLength(1);
  });

  it("unique (tenant_id,customer_id) — insert ซ้ำถูกปฏิเสธ (simulation)", async () => {
    const uniqueIndexes = [{ table: "payroll_settings", columns: ["tenant_id", "customer_id"] }];
    const { db } = makeInMemoryDb(tables, { uniqueIndexes });
    await db.from("payroll_settings").insert({ tenant_id: TENANT, customer_id: CUSTOMER_A, salary_expense_account_code: "5310" });
    const { error } = await db
      .from("payroll_settings")
      .insert({ tenant_id: TENANT, customer_id: CUSTOMER_A, salary_expense_account_code: "5310" })
      .select("id")
      .maybeSingle();
    expect((error as { code?: string } | null)?.code).toBe("23505");
  });

  it("upsertSettings — สร้างใหม่แล้วแก้ไขได้ (upsert ตาม unique tenant+customer)", async () => {
    const { db } = makeInMemoryDb(tables);
    const created = await upsertSettings(db, TENANT, CUSTOMER_A, validInput(), chartByCode);
    expect(created.ok).toBe(true);
    const updated = await upsertSettings(
      db,
      TENANT,
      CUSTOMER_A,
      validInput({ otherDeductionsAccountCode: "2015", netPayAccountCode: "2040" }),
      chartByCode
    );
    expect(updated.ok).toBe(true);
    const settings = await getSettings(db, TENANT, CUSTOMER_A);
    expect(settings?.otherDeductionsAccountCode).toBe("2015");
    expect(settings?.netPayAccountCode).toBe("2040");
    expect(tables.payroll_settings).toHaveLength(1);
  });

  it("upsertSettings — validate ผิด → ไม่เขียน DB", async () => {
    const { db } = makeInMemoryDb(tables);
    const res = await upsertSettings(db, TENANT, CUSTOMER_A, validInput({ salaryExpenseAccountCode: "2910" }), chartByCode);
    expect(res.ok).toBe(false);
    expect(tables.payroll_settings).toHaveLength(0);
  });
});
