import { describe, it, expect } from "vitest";
import { validatePlatformReportSettingsInput, accountCodeForDeductionCategory } from "@/lib/accounting/platform-report-settings";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import type { PlatformReportSettings } from "@/lib/accounting/platform-report-settings";

const CHART: ChartByCode = {
  "4010": { code: "4010", name: "ขายสินค้า", category: "รายได้" },
  "5344": { code: "5344", name: "ค่าบริการแพลตฟอร์ม", category: "ค่าใช้จ่าย" },
  "5355": { code: "5355", name: "ค่าธรรมเนียมอื่น ๆ", category: "ค่าใช้จ่าย" },
  "5341": { code: "5341", name: "ค่าขนส่ง", category: "ค่าใช้จ่าย" },
  "5315": { code: "5315", name: "ค่าโฆษณา", category: "ค่าใช้จ่าย" },
  "5365": { code: "5365", name: "ค่าใช้จ่ายเบ็ดเตล็ด", category: "ค่าใช้จ่าย" },
  "1020": { code: "1020", name: "เงินฝากธนาคาร #1", category: "สินทรัพย์" },
};

function validInput() {
  return {
    salesAccountCode: "4010",
    commissionFeeAccountCode: "5344",
    paymentFeeAccountCode: "5355",
    shippingFeeAccountCode: "5341",
    adsFeeAccountCode: "5315",
    penaltyAccountCode: "5365",
    refundAccountCode: "4010",
    otherAccountCode: "5365",
    clearingAccountCode: "1020",
  };
}

describe("validatePlatformReportSettingsInput", () => {
  it("input ครบถูกหมวด → ผ่าน", () => {
    const r = validatePlatformReportSettingsInput(validInput(), CHART);
    expect(r.ok).toBe(true);
  });

  it("รหัสบัญชีไม่อยู่ในผัง → ปฏิเสธ", () => {
    const r = validatePlatformReportSettingsInput({ ...validInput(), salesAccountCode: "9999" }, CHART);
    expect(r.ok).toBe(false);
  });

  it("sales อยู่หมวดผิด (ค่าใช้จ่ายแทนรายได้) → ปฏิเสธ", () => {
    const r = validatePlatformReportSettingsInput({ ...validInput(), salesAccountCode: "5344" }, CHART);
    expect(r.ok).toBe(false);
  });

  it("clearing ต้องอยู่หมวดสินทรัพย์ — ใส่บัญชีรายได้ → ปฏิเสธ", () => {
    const r = validatePlatformReportSettingsInput({ ...validInput(), clearingAccountCode: "4010" }, CHART);
    expect(r.ok).toBe(false);
  });

  it("commission_fee ต้องอยู่หมวดค่าใช้จ่าย — ใส่บัญชีสินทรัพย์ → ปฏิเสธ", () => {
    const r = validatePlatformReportSettingsInput({ ...validInput(), commissionFeeAccountCode: "1020" }, CHART);
    expect(r.ok).toBe(false);
  });

  it("ไม่ระบุรหัสบัญชี (undefined) → ปฏิเสธ (ทุกฟิลด์ required)", () => {
    const r = validatePlatformReportSettingsInput({ ...validInput(), otherAccountCode: undefined }, CHART);
    expect(r.ok).toBe(false);
  });
});

describe("accountCodeForDeductionCategory", () => {
  const s: PlatformReportSettings = {
    id: "1",
    tenantId: "t",
    customerId: "c",
    ...validInput(),
    createdAt: "",
    updatedAt: "",
  };

  it("map แต่ละประเภทไปยังรหัสบัญชีที่ตั้งไว้ถูกต้อง", () => {
    expect(accountCodeForDeductionCategory(s, "commission_fee")).toBe("5344");
    expect(accountCodeForDeductionCategory(s, "payment_fee")).toBe("5355");
    expect(accountCodeForDeductionCategory(s, "shipping_fee")).toBe("5341");
    expect(accountCodeForDeductionCategory(s, "ads_fee")).toBe("5315");
    expect(accountCodeForDeductionCategory(s, "penalty")).toBe("5365");
    expect(accountCodeForDeductionCategory(s, "refund")).toBe("4010");
  });

  it("category ที่ไม่รู้จัก/other → fallback ไปบัญชี 'อื่นๆ'", () => {
    expect(accountCodeForDeductionCategory(s, "other")).toBe("5365");
  });
});
