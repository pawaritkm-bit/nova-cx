/**
 * หนังสือรับรองหัก ณ ที่จ่ายของ "พนักงานเงินเดือน" (50 ทวิ) — ★ pure ล้วน ไม่แตะ DB
 *
 * บริบท: เฟส 9b กลุ่ม BD (docs/06-accounting-features-roadmap.md, หมวด 0.4) — ★★★ ต่างจาก
 *   `lib/accounting/wht-cert.ts` เดิม (เฟส 3 ส่วน I) ที่ใช้กับบิลซื้อ (มาตรา 3 เตรส) เท่านั้น — ไฟล์นี้แยก
 *   ต่างหากเพราะโดเมนข้อมูลต่างกันโดยสิ้นเชิง (ผูกกับ `payroll_run_lines`/`payroll_employees` ไม่ใช่
 *   `bill_entries`) แต่ mirror สไตล์ "pure, print-only, ไม่มี migration ใหม่" เดียวกัน
 *
 * ★★★ 0.4 — ยอดยกมาจากนายจ้างเดิม (`prior_employer_ytd_*`) เป็น "ข้อมูลอ้างอิงเพื่อพิมพ์เอกสารเท่านั้น"
 *   แสดงเป็นบรรทัดแยกต่างหากเสมอ **ห้ามบวกรวมเข้ายอดของนายจ้างปัจจุบันเป็นยอดเดียว** (การ reconcile ยอดรวม
 *   ข้ามนายจ้างเป็นหน้าที่พนักงานตอนยื่น ภ.ง.ด.90/91 เอง) — ไฟล์นี้ไม่ import/แตะ payroll-tax.ts เลย
 */
import { round2 } from "@/lib/accounting/queries";

export type PayrollWhtCertRunLine = {
  payPeriodYear: number;
  payPeriodMonth: number;
  grossSalary: number;
  otherAdditions: number;
  bonusAmount: number;
  pitWithheld: number;
};

export type PayrollWhtCertPriorEmployerYtd = {
  gross: number | null;
  pitWithheld: number | null;
  ssoEmployee: number | null;
  note: string | null;
};

/** 1 บรรทัดสรุปต่อเดือนของนายจ้างปัจจุบัน (เรียงเดือน 1-12) */
export type PayrollWhtCertMonthlyRow = {
  payPeriodMonth: number;
  income: number;
  pitWithheld: number;
};

export type PayrollWhtCertData = {
  taxYear: number;
  /** ยอดเงินได้รวมทั้งปีของนายจ้างปัจจุบัน (เฉพาะปีภาษีที่ระบุ) */
  currentEmployerTotalIncome: number;
  /** ภาษีหัก ณ ที่จ่ายรวมทั้งปีของนายจ้างปัจจุบัน (เฉพาะปีภาษีที่ระบุ) */
  currentEmployerTotalPitWithheld: number;
  monthlyBreakdown: PayrollWhtCertMonthlyRow[];
  /** null ถ้าพนักงานไม่มียอดยกมาจากนายจ้างเดิมเลย (ไม่กรอกไว้) — แสดงเป็นบรรทัดแยกต่างหากเสมอ ไม่ผสมรวม */
  priorEmployer: PayrollWhtCertPriorEmployerYtd | null;
};

/** true ถ้ามีตัวเลข YTD นายจ้างเดิมอย่างน้อย 1 ค่า (ไม่นับ note เฉย ๆ) */
function hasPriorEmployerYtd(p: PayrollWhtCertPriorEmployerYtd | null): boolean {
  if (!p) return false;
  return p.gross !== null || p.pitWithheld !== null || p.ssoEmployee !== null;
}

/**
 * รวมยอดรายเดือนของนายจ้างปัจจุบันเป็นยอดรวมทั้งปีภาษี + แนบยอด YTD นายจ้างเดิมเป็นบรรทัดอ้างอิงแยก (0.4)
 *   ★ กรองเฉพาะบรรทัดที่ payPeriodYear === taxYear เท่านั้น (กันเผลอส่ง runLines ข้ามปีมาปนกัน)
 *   ★ เงินได้ต่อเดือน = gross_salary + other_additions + bonus_amount (เงินได้พึงประเมินตามมาตรา 40(1) ที่
 *   จ่ายจริงงวดนั้น ไม่ใช่ annualEstimate ที่ใช้ในสูตรคำนวณภาษี — คนละความหมายกัน)
 */
export function buildPayrollWhtCertData(
  taxYear: number,
  runLines: PayrollWhtCertRunLine[],
  priorEmployerYtd: PayrollWhtCertPriorEmployerYtd | null
): PayrollWhtCertData {
  const linesOfYear = runLines.filter((l) => l.payPeriodYear === taxYear);

  const byMonth = new Map<number, { income: number; pitWithheld: number }>();
  for (const l of linesOfYear) {
    const income = l.grossSalary + l.otherAdditions + l.bonusAmount;
    const prev = byMonth.get(l.payPeriodMonth) ?? { income: 0, pitWithheld: 0 };
    byMonth.set(l.payPeriodMonth, {
      income: prev.income + income,
      pitWithheld: prev.pitWithheld + l.pitWithheld,
    });
  }

  const monthlyBreakdown: PayrollWhtCertMonthlyRow[] = [...byMonth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([payPeriodMonth, v]) => ({ payPeriodMonth, income: round2(v.income), pitWithheld: round2(v.pitWithheld) }));

  const currentEmployerTotalIncome = round2(monthlyBreakdown.reduce((s, r) => s + r.income, 0));
  const currentEmployerTotalPitWithheld = round2(monthlyBreakdown.reduce((s, r) => s + r.pitWithheld, 0));

  return {
    taxYear,
    currentEmployerTotalIncome,
    currentEmployerTotalPitWithheld,
    monthlyBreakdown,
    priorEmployer: hasPriorEmployerYtd(priorEmployerYtd) ? priorEmployerYtd : null,
  };
}
