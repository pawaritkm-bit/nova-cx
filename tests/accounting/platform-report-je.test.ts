import { describe, it, expect } from "vitest";
import { buildPlatformReportJournalEntryInput } from "@/lib/accounting/platform-report-je";
import { isBalanced, validateManualEntryInput } from "@/lib/accounting/manual-journal";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import type { PlatformReportSummary } from "@/lib/accounting/platform-report-analyze";
import type { PlatformReportSettings } from "@/lib/accounting/platform-report-settings";

/** ผังบัญชีจำลอง (ครอบคลุมรหัสที่ settings ทดสอบใช้) */
const CHART: ChartByCode = {
  "4010": { code: "4010", name: "ขายสินค้า", category: "รายได้" },
  "5344": { code: "5344", name: "ค่าบริการแพลตฟอร์ม", category: "ค่าใช้จ่าย" },
  "5355": { code: "5355", name: "ค่าธรรมเนียมอื่น ๆ", category: "ค่าใช้จ่าย" },
  "5341": { code: "5341", name: "ค่าขนส่ง", category: "ค่าใช้จ่าย" },
  "5315": { code: "5315", name: "ค่าโฆษณา", category: "ค่าใช้จ่าย" },
  "5365": { code: "5365", name: "ค่าใช้จ่ายเบ็ดเตล็ด", category: "ค่าใช้จ่าย" },
  "1020": { code: "1020", name: "เงินฝากธนาคาร #1", category: "สินทรัพย์" },
};

function settings(overrides: Partial<PlatformReportSettings> = {}): PlatformReportSettings {
  return {
    id: "s1",
    tenantId: "t1",
    customerId: "c1",
    salesAccountCode: "4010",
    commissionFeeAccountCode: "5344",
    paymentFeeAccountCode: "5355",
    shippingFeeAccountCode: "5341",
    adsFeeAccountCode: "5315",
    penaltyAccountCode: "5365",
    refundAccountCode: "4010",
    otherAccountCode: "5365",
    clearingAccountCode: "1020",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function summary(overrides: Partial<PlatformReportSummary> = {}): PlatformReportSummary {
  return {
    grossSales: 0,
    otherCredit: 0,
    deductions: [],
    totalDeductions: 0,
    netAmount: 0,
    count: 0,
    ...overrides,
  };
}

describe("buildPlatformReportJournalEntryInput", () => {
  it("สร้าง JE สมดุลถูกต้อง: Cr ยอดขาย = Dr ค่าใช้จ่ายแต่ละประเภท + Dr เงินที่ได้รับจริง", () => {
    const s = summary({
      grossSales: 3000,
      deductions: [
        { category: "commission_fee", count: 2, total: 300 },
        { category: "payment_fee", count: 1, total: 20 },
        { category: "shipping_fee", count: 1, total: 50 },
        { category: "ads_fee", count: 1, total: 80 },
      ],
      totalDeductions: 450,
      netAmount: 2550,
      count: 7,
    });
    const r = buildPlatformReportJournalEntryInput(s, settings(), "2026-07-31");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.docType).toBe("JV");
    expect(r.value.docDate).toBe("2026-07-31");

    const v = validateManualEntryInput(r.value, CHART);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(isBalanced(v.value.lines)).toBe(true);

    const byCode = new Map(v.value.lines.map((l) => [l.accountCode, l]));
    expect(byCode.get("4010")?.credit).toBe(3000);
    expect(byCode.get("5344")?.debit).toBe(300);
    expect(byCode.get("5355")?.debit).toBe(20);
    expect(byCode.get("5341")?.debit).toBe(50);
    expect(byCode.get("5315")?.debit).toBe(80);
    expect(byCode.get("1020")?.debit).toBe(2550);
  });

  it("netAmount ติดลบ (ค่าธรรมเนียมมากกว่ายอดขาย) → clearing กลายเป็นฝั่งเครดิต แต่ยังสมดุล", () => {
    const s = summary({
      grossSales: 100,
      deductions: [{ category: "commission_fee", count: 1, total: 300 }],
      totalDeductions: 300,
      netAmount: -200,
      count: 2,
    });
    const r = buildPlatformReportJournalEntryInput(s, settings(), "2026-07-31");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateManualEntryInput(r.value, CHART);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(isBalanced(v.value.lines)).toBe(true);
    const clearing = v.value.lines.find((l) => l.accountCode === "1020");
    expect(clearing?.credit).toBe(200);
    expect(clearing?.debit).toBe(0);
  });

  it("refund ชี้บัญชีเดียวกับ sales (default) → หักลบกันเหลือยอดขายสุทธิบรรทัดเดียว (contra-revenue ถูกต้อง)", () => {
    const s = summary({
      grossSales: 1000,
      deductions: [{ category: "refund", count: 1, total: 300 }],
      totalDeductions: 300,
      netAmount: 700,
      count: 2,
    });
    const r = buildPlatformReportJournalEntryInput(s, settings(), "2026-07-31");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateManualEntryInput(r.value, CHART);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // ต้องไม่มีบรรทัดแยกสำหรับ 4010 สองบรรทัด (หักลบกันแล้วเหลือบรรทัดเดียว)
    const salesLines = v.value.lines.filter((l) => l.accountCode === "4010");
    expect(salesLines.length).toBe(1);
    expect(salesLines[0].credit).toBe(700); // 1000 - 300
    expect(isBalanced(v.value.lines)).toBe(true);
  });

  it("count=0 (ไม่มีรายการ) → ปฏิเสธ ไม่สร้าง JE เปล่า", () => {
    const r = buildPlatformReportJournalEntryInput(summary({ count: 0 }), settings(), "2026-07-31");
    expect(r.ok).toBe(false);
  });

  it("ทุกยอดเป็น 0 (มีรายการแต่ไม่มีมูลค่า) → ปฏิเสธ ไม่พอสร้าง JE สมดุล", () => {
    const r = buildPlatformReportJournalEntryInput(summary({ count: 1 }), settings(), "2026-07-31");
    expect(r.ok).toBe(false);
  });

  it("otherCredit > 0 → รวมเข้ายอดขายบัญชีเดียวกัน", () => {
    const s = summary({ grossSales: 1000, otherCredit: 50, netAmount: 1050, count: 2 });
    const r = buildPlatformReportJournalEntryInput(s, settings(), "2026-07-31");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateManualEntryInput(r.value, CHART);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.lines.find((l) => l.accountCode === "4010")?.credit).toBe(1050);
  });
});
