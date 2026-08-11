import { describe, it, expect } from "vitest";
import { buildPayrollWhtCertData, type PayrollWhtCertRunLine } from "@/lib/accounting/payroll-wht-cert";

/**
 * เทสต์ lib/accounting/payroll-wht-cert.ts (เฟส 9b กลุ่ม BD, T149)
 *   ★ pure ล้วน — ไม่แตะ DB / ไม่แตะ payroll-tax.ts
 *   ★★★ 0.4 จุดที่ต้องพิสูจน์: ยอด YTD นายจ้างเดิมต้องแยกเป็นบรรทัดอ้างอิงต่างหากเสมอ ไม่ถูกบวกรวมเข้า
 *   currentEmployerTotalIncome/currentEmployerTotalPitWithheld
 */

function line(p: Partial<PayrollWhtCertRunLine>): PayrollWhtCertRunLine {
  return {
    payPeriodYear: 2569,
    payPeriodMonth: 1,
    grossSalary: 0,
    otherAdditions: 0,
    bonusAmount: 0,
    pitWithheld: 0,
    ...p,
  };
}

describe("buildPayrollWhtCertData (BD)", () => {
  it("รวมยอดรายเดือน 12 เดือนเป็นยอดรวมทั้งปีถูกต้อง", () => {
    const lines: PayrollWhtCertRunLine[] = Array.from({ length: 12 }, (_, i) =>
      line({ payPeriodMonth: i + 1, grossSalary: 20000, pitWithheld: 100 })
    );
    const data = buildPayrollWhtCertData(2569, lines, null);
    expect(data.currentEmployerTotalIncome).toBe(240000);
    expect(data.currentEmployerTotalPitWithheld).toBe(1200);
    expect(data.monthlyBreakdown).toHaveLength(12);
    expect(data.monthlyBreakdown[0].payPeriodMonth).toBe(1);
    expect(data.monthlyBreakdown[11].payPeriodMonth).toBe(12);
  });

  it("เงินได้ต่อเดือน = gross + other_additions + bonus", () => {
    const lines: PayrollWhtCertRunLine[] = [
      line({ payPeriodMonth: 12, grossSalary: 60000, otherAdditions: 1000, bonusAmount: 90000, pitWithheld: 16541.67 }),
    ];
    const data = buildPayrollWhtCertData(2569, lines, null);
    expect(data.monthlyBreakdown[0].income).toBe(151000);
    expect(data.currentEmployerTotalIncome).toBe(151000);
  });

  it("★ กรองเฉพาะบรรทัดของปีภาษีที่ระบุ — บรรทัดปีอื่นไม่ถูกนับ", () => {
    const lines: PayrollWhtCertRunLine[] = [
      line({ payPeriodYear: 2568, payPeriodMonth: 12, grossSalary: 99999, pitWithheld: 999 }),
      line({ payPeriodYear: 2569, payPeriodMonth: 1, grossSalary: 20000, pitWithheld: 100 }),
    ];
    const data = buildPayrollWhtCertData(2569, lines, null);
    expect(data.monthlyBreakdown).toHaveLength(1);
    expect(data.currentEmployerTotalIncome).toBe(20000);
  });

  it("ไม่มีบรรทัดของปีนี้เลย → ยอดรวมเป็น 0 ไม่ throw", () => {
    const data = buildPayrollWhtCertData(2569, [], null);
    expect(data.currentEmployerTotalIncome).toBe(0);
    expect(data.currentEmployerTotalPitWithheld).toBe(0);
    expect(data.monthlyBreakdown).toHaveLength(0);
  });

  it("★★★ ไม่มียอด YTD นายจ้างเดิมกรอกไว้เลย (ทุกค่า null) → priorEmployer=null (ไม่แสดงบล็อกอ้างอิง)", () => {
    const data = buildPayrollWhtCertData(2569, [], { gross: null, pitWithheld: null, ssoEmployee: null, note: null });
    expect(data.priorEmployer).toBeNull();
  });

  it("★★★ มียอด YTD นายจ้างเดิมบางส่วน → priorEmployer มีค่า และไม่ถูกบวกรวมเข้ายอดนายจ้างปัจจุบัน", () => {
    const lines: PayrollWhtCertRunLine[] = [line({ payPeriodMonth: 7, grossSalary: 20000, pitWithheld: 100 })];
    const priorYtd = { gross: 150000, pitWithheld: 5000, ssoEmployee: null, note: "บริษัท เอบีซี จำกัด" };
    const data = buildPayrollWhtCertData(2569, lines, priorYtd);
    expect(data.priorEmployer).toEqual(priorYtd);
    // ★ ยอดรวมนายจ้างปัจจุบันต้องไม่ถูกผสมกับยอด YTD นายจ้างเดิมเลยแม้แต่บาทเดียว
    expect(data.currentEmployerTotalIncome).toBe(20000);
    expect(data.currentEmployerTotalPitWithheld).toBe(100);
  });

  it("★ พนักงานเข้าใหม่กลางปีที่มี prior YTD — เดือนก่อนเข้างานไม่มีบรรทัด (— ในตาราง) แต่ยอดรวม/YTD ยังถูกต้อง", () => {
    const lines: PayrollWhtCertRunLine[] = [
      line({ payPeriodMonth: 7, grossSalary: 20000, pitWithheld: 100 }),
      line({ payPeriodMonth: 8, grossSalary: 20000, pitWithheld: 100 }),
    ];
    const priorYtd = { gross: 120000, pitWithheld: 4000, ssoEmployee: 3000, note: null };
    const data = buildPayrollWhtCertData(2569, lines, priorYtd);
    expect(data.monthlyBreakdown).toHaveLength(2);
    expect(data.currentEmployerTotalIncome).toBe(40000);
    expect(data.priorEmployer?.gross).toBe(120000);
  });
});
