import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";
import { buildPayslipPdfBuffer, payslipFilename, buildPayslipEmailContent } from "@/lib/accounting/payroll-payslip-pdf";
import type { PayrollRun, PayrollRunLine } from "@/lib/accounting/payroll";

/**
 * เทสต์ lib/accounting/payroll-payslip-pdf.ts (wishlist ข้อ 6 — ส่งสลิปเงินเดือนทางอีเมล)
 *   ★ ใช้ pdf-parse อ่านข้อความกลับจาก Buffer ที่สร้างจริง เพื่อยืนยันว่าตัวเลข/วรรคตอนไม่หายไป
 *   (ปัญหา font-subsetting ที่พบและแก้ก่อนเขียนไฟล์นี้ — ดู lib/pdf/thai-text.ts)
 */

function mkRun(overrides: Partial<PayrollRun> = {}): PayrollRun {
  return {
    id: "run-1",
    tenantId: "tenant-1",
    customerId: "cust-1",
    payPeriodYear: 2569,
    payPeriodMonth: 8,
    payDate: "2026-08-31",
    status: "finalized",
    manualEntryId: "je-1",
    pitFilingStatus: "not_filed",
    pitFiledAt: null,
    pitFiledBy: null,
    ssoFilingStatus: "not_filed",
    ssoFiledAt: null,
    ssoFiledBy: null,
    filingPeriodId: "fp-1",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function mkLine(overrides: Partial<PayrollRunLine> = {}): PayrollRunLine {
  return {
    id: "line-1",
    runId: "run-1",
    payrollEmployeeId: "emp-1",
    employeeFullName: "สมชาย ใจดี",
    employeeCode: "E001",
    grossSalary: 20000,
    otherAdditions: 500,
    bonusAmount: 0,
    otherDeductions: 100,
    pitWithheld: 150.75,
    ssoEmployee: 750,
    ssoEmployer: 750,
    severanceAmount: 0,
    severancePitWithheld: 0,
    netPay: 19499.25,
    isProrated: false,
    proratedDaysWorked: 0,
    proratedDaysInMonth: 0,
    extraDeductionsPreviewTotal: 0,
    personalAllowancePreview: 60000,
    deductionWarnings: [],
    statutorySeveranceDaysHelper: 0,
    severancePitWithheldPreview: 0,
    severanceEligibleForSeparateCalc: false,
    ...overrides,
  };
}

async function pdfToText(buf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  await parser.destroy();
  return result.text;
}

describe("buildPayslipPdfBuffer", () => {
  it("สร้าง PDF Buffer อ่านกลับได้ + มีชื่อพนักงาน+ยอดเงิน+เครื่องหมายวรรคตอนครบ (ไม่หายจาก font subsetting)", async () => {
    const buf = await buildPayslipPdfBuffer(mkRun(), mkLine());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);

    const text = await pdfToText(buf);
    expect(text).toContain("สลิปเงินเดือน");
    expect(text).toContain("สมชาย ใจดี");
    expect(text).toContain("E001");
    expect(text).toContain("20,000.00");
    expect(text).toContain("150.75");
    expect(text).toContain("19,499.25");
    expect(text).toContain("เงินเดือนสุทธิ (รับจริง)");
    expect(text).toContain("ประกันสังคม (ส่วนนายจ้าง — นายจ้างสมทบให้ ไม่หักจากพนักงาน)");
  });

  it("ไม่มีรหัสพนักงาน → ไม่แสดงแถวรหัสพนักงาน", async () => {
    const buf = await buildPayslipPdfBuffer(mkRun(), mkLine({ employeeCode: null }));
    const text = await pdfToText(buf);
    expect(text).not.toContain("รหัสพนักงาน");
  });

  it("มีค่าชดเชยเลิกจ้าง > 0 → แสดงแถวค่าชดเชย+ภาษีค่าชดเชย", async () => {
    const buf = await buildPayslipPdfBuffer(
      mkRun(),
      mkLine({ severanceAmount: 30000, severancePitWithheld: 500 })
    );
    const text = await pdfToText(buf);
    expect(text).toContain("ค่าชดเชยเลิกจ้าง");
    expect(text).toContain("หัก: ภาษีหัก ณ ที่จ่าย (ค่าชดเชย)");
    expect(text).toContain("30,000.00");
  });

  it("ไม่มีค่าชดเชยเลิกจ้าง (0) → ไม่แสดงแถวค่าชดเชย", async () => {
    const buf = await buildPayslipPdfBuffer(mkRun(), mkLine({ severanceAmount: 0 }));
    const text = await pdfToText(buf);
    expect(text).not.toContain("ค่าชดเชยเลิกจ้าง");
  });
});

describe("payslipFilename", () => {
  it("ใช้รหัสพนักงาน+ปี-เดือน เป็นชื่อไฟล์ ASCII เท่านั้น", () => {
    const name = payslipFilename(mkRun(), mkLine());
    expect(name).toBe("payslip_E001_2569-08.pdf");
    expect(/^[\x20-\x7e]+$/.test(name)).toBe(true);
  });

  it("ไม่มีรหัสพนักงาน → ใช้ 8 ตัวแรกของ payrollEmployeeId แทน", () => {
    const name = payslipFilename(mkRun(), mkLine({ employeeCode: null, payrollEmployeeId: "abcdef12-3456" }));
    expect(name).toBe("payslip_abcdef12_2569-08.pdf");
  });
});

describe("buildPayslipEmailContent", () => {
  it("subject/text มีชื่อพนักงาน+งวด+วันที่จ่าย", () => {
    const { subject, text } = buildPayslipEmailContent(mkRun(), mkLine());
    expect(subject).toContain("ส.ค.");
    expect(subject).toContain("2569");
    expect(text).toContain("สมชาย ใจดี");
    expect(text).toContain("2026-08-31");
  });
});
