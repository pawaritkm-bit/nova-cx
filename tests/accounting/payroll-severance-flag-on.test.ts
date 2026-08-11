import { describe, it, expect, vi } from "vitest";

/**
 * ★★★ เฟส 9b กลุ่ม BF (T164, 0.2) — จำลอง ENABLE_SEVERANCE_TAX_CALC=true "ในเทสต์เท่านั้น" ตามที่ DoD ของ
 *   T164 ระบุ (mirror ถ้อยคำเดียวกันกับ T154 ของกลุ่ม BE)
 *
 *   ★ ทำไมต้องเป็นไฟล์แยก + ใช้ vi.mock แทนการ import แล้วเขียนค่า `ENABLE_SEVERANCE_TAX_CALC = true` ตรง ๆ:
 *   payroll-tax.ts export ตัวแปรด้วย `let` แต่ ES module namespace object ที่ import มาเป็น read-only เสมอ
 *   (เขียนทับ property ตรง ๆ จะ throw `Cannot set property ... which has only a getter`) — vi.mock คือทางเดียว
 *   ที่ mock เฉพาะค่านี้ให้เป็น `true` ได้โดย**ไม่แก้ default ในซอร์สโค้ดจริงเลย** (default ยังคง `false` เสมอใน
 *   payroll-tax.ts ตามข้อบังคับ 0.2 — ไฟล์นี้จำลองผลลัพธ์เฉพาะตอนเทสต์เพื่อพิสูจน์ว่า engine พร้อมใช้งานจริงทันที
 *   ที่ verify golden test ได้ ไม่ใช่การเปิด flag จริง)
 *   ★ vi.mock ที่นี่มีผลแค่ในไฟล์นี้เท่านั้น (vitest isolate module graph ต่อไฟล์) — ไม่กระทบ payroll.test.ts/
 *   payroll-tax.test.ts อื่นที่ยืนยันว่า flag ยัง false อยู่
 *
 *   ★ ขอบเขตของเทสต์นี้ = ทดสอบ "การเดินสาย" (wiring) ของ recalcRunLines เข้ากับ calcSeveranceWithholding/
 *   calcYearsOfServiceForTaxFormula ให้ถูกต้อง — ไม่ใช่ทดสอบความถูกต้องของสูตรเอง (สูตร calcSeveranceWithholding/
 *   calcStatutorySeveranceDays/calcYearsOfServiceForTaxFormula มี self-consistent test ครบแล้วใน
 *   payroll-tax.test.ts) จึงคำนวณค่าที่คาดหวังผ่านฟังก์ชัน pure ตัวจริงตัวเดียวกัน (ไม่ hardcode เลขจากการคำนวณมือ
 *   ที่มีโอกาสพลาดจากความซับซ้อนของสูตรหลายชั้นซ้อนกัน)
 */
vi.mock("@/lib/accounting/payroll-tax", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accounting/payroll-tax")>();
  return { ...actual, ENABLE_SEVERANCE_TAX_CALC: true };
});

import { makeInMemoryDb, type Tables } from "../helpers/fake-payroll-db";
import { createDraftRun, recalcRunLines } from "@/lib/accounting/payroll";
import {
  calcYearsOfServiceForTaxFormula,
  calcSeveranceWithholding,
  calcMonthlyPitForRegularIncome,
  calcSsoContribution,
  PERSONAL_ALLOWANCE_STANDARD,
} from "@/lib/accounting/payroll-tax";
import type { PitBracket } from "@/lib/accounting/payroll-config";

const TENANT = "tenant-1";
const CUSTOMER_A = "cust-a";

const BRACKETS: PitBracket[] = [
  { bracketOrder: 1, incomeFrom: 0, incomeTo: 150000, ratePercent: 0 },
  { bracketOrder: 2, incomeFrom: 150001, incomeTo: 300000, ratePercent: 5 },
  { bracketOrder: 3, incomeFrom: 300001, incomeTo: 500000, ratePercent: 10 },
  { bracketOrder: 4, incomeFrom: 500001, incomeTo: 750000, ratePercent: 15 },
  { bracketOrder: 5, incomeFrom: 750001, incomeTo: 1000000, ratePercent: 20 },
  { bracketOrder: 6, incomeFrom: 1000001, incomeTo: 2000000, ratePercent: 25 },
  { bracketOrder: 7, incomeFrom: 2000001, incomeTo: 5000000, ratePercent: 30 },
  { bracketOrder: 8, incomeFrom: 5000001, incomeTo: null, ratePercent: 35 },
];
const SSO_CONFIG = { employeeRatePercent: 5, employerRatePercent: 5, wageFloor: 1650, wageCeiling: 17500 };

function baseTables(): Tables {
  return {
    payroll_employees: [],
    payroll_runs: [],
    payroll_run_lines: [],
    pit_tax_brackets: BRACKETS.map((b, i) => ({
      id: `b${i + 1}`,
      effective_from: "2017-01-01",
      bracket_order: b.bracketOrder,
      income_from: b.incomeFrom,
      income_to: b.incomeTo,
      rate_percent: b.ratePercent,
    })),
    sso_contribution_config: [
      {
        id: "s1",
        effective_from: "1997-01-01",
        employee_rate_percent: SSO_CONFIG.employeeRatePercent,
        employer_rate_percent: SSO_CONFIG.employerRatePercent,
        wage_floor: SSO_CONFIG.wageFloor,
        wage_ceiling: SSO_CONFIG.wageCeiling,
      },
    ],
    payroll_settings: [],
  };
}

function seedEmployee(tables: Tables, opts: { startDate: string | null; resignDate: string | null }): string {
  const id = "emp-1";
  tables.payroll_employees.push({
    id,
    tenant_id: TENANT,
    customer_id: CUSTOMER_A,
    employee_code: "E1",
    full_name: "พนักงานทดสอบเลิกจ้าง",
    id_card_no: null,
    passport_no: "P1",
    position: null,
    base_salary: 30000,
    start_date: opts.startDate,
    resign_date: opts.resignDate,
    is_active: true,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  return id;
}

const PAY_DATE = "2026-08-10";

describe("★★★ BF (T164) — จำลอง ENABLE_SEVERANCE_TAX_CALC=true ผ่าน vi.mock (ไม่แก้ default จริงในซอร์ส)", () => {
  it("severance_amount > 0 + flag=true (mocked) → severance_pit_withheld คำนวณจริงตามสูตร calcSeveranceWithholding (wiring ถูกต้อง)", async () => {
    const tables = baseTables();
    const START_DATE = "2015-01-01";
    const empId = seedEmployee(tables, { startDate: START_DATE, resignDate: PAY_DATE });
    const { db } = makeInMemoryDb(tables);
    const created = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: PAY_DATE });
    expect(created.ok).toBe(true);
    const runId = (created as { id: string }).id;
    const lineId = tables.payroll_run_lines.find((l) => l.payroll_employee_id === empId)!.id as string;

    const GROSS = 30000;
    const SEVERANCE = 2000000;
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
      { id: lineId, grossSalary: GROSS, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0, severanceAmount: SEVERANCE },
    ]);
    expect(res.ok).toBe(true);

    // ★ ค่าคาดหวัง — คำนวณผ่านฟังก์ชัน pure ตัวจริงตัวเดียวกันที่ recalcRunLines เรียกใช้ (ทดสอบ wiring ไม่ใช่สูตร)
    const expectedYears = calcYearsOfServiceForTaxFormula(START_DATE, PAY_DATE);
    expect(expectedYears).toBeGreaterThan(0); // sanity: ต้องมีอายุงานจริงสำหรับเคสนี้ (11-12 ปี)
    const expectedSeverancePit = calcSeveranceWithholding(SEVERANCE, GROSS, expectedYears, BRACKETS).tax;
    const expectedRegularPit = calcMonthlyPitForRegularIncome(GROSS, 12, PERSONAL_ALLOWANCE_STANDARD, BRACKETS);
    const expectedSso = calcSsoContribution(GROSS, SSO_CONFIG).employeeContribution;

    const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
    expect(line.severance_amount).toBe(SEVERANCE);
    expect(line.severance_pit_withheld).toBe(expectedSeverancePit);
    // ★ กฎเหล็ก — severance ไม่กระทบ pit_withheld ของเงินเดือนปกติเลย (คำนวณแยกสูตรกันเด็ดขาด)
    expect(line.pit_withheld).toBe(expectedRegularPit);
    expect(line.net_pay).toBe(
      Math.round((GROSS + SEVERANCE - expectedRegularPit - expectedSso - expectedSeverancePit) * 100) / 100
    );
  });

  it("severance_amount = 0 (ไม่มีค่าชดเชย) + flag=true (mocked) → severance_pit_withheld ยังเป็น 0 (ไม่คำนวณภาษีจากอากาศ แม้อายุงานมาก)", async () => {
    const tables = baseTables();
    const empId = seedEmployee(tables, { startDate: "2015-01-01", resignDate: null });
    const { db } = makeInMemoryDb(tables);
    const created = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: PAY_DATE });
    const runId = (created as { id: string }).id;
    const lineId = tables.payroll_run_lines.find((l) => l.payroll_employee_id === empId)!.id as string;

    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId);
    expect(res.ok).toBe(true);
    const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
    expect(line.severance_amount).toBe(0);
    expect(line.severance_pit_withheld).toBe(0);
  });

  it("ทำงานไม่ถึงปี (yearsOfServiceForTaxFormula=0) + severance_amount>0 + flag=true → ไม่ throw, expense=0 ตามสูตร", async () => {
    const tables = baseTables();
    // เข้าทำงาน 2026-06-01, เลิกจ้าง 2026-08-10 (payDate) — ทำงานไม่ถึงปี → years=0
    const empId = seedEmployee(tables, { startDate: "2026-06-01", resignDate: PAY_DATE });
    const { db } = makeInMemoryDb(tables);
    const created = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: PAY_DATE });
    const runId = (created as { id: string }).id;
    const lineId = tables.payroll_run_lines.find((l) => l.payroll_employee_id === empId)!.id as string;

    const GROSS = 30000;
    const SEVERANCE = 50000;
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
      { id: lineId, grossSalary: GROSS, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0, severanceAmount: SEVERANCE },
    ]);
    expect(res.ok).toBe(true);

    const years = calcYearsOfServiceForTaxFormula("2026-06-01", PAY_DATE);
    expect(years).toBe(0);
    const expected = calcSeveranceWithholding(SEVERANCE, GROSS, years, BRACKETS);
    expect(expected.expense).toBe(0);

    const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
    expect(line.severance_pit_withheld).toBe(expected.tax);
  });
});
