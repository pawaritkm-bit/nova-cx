import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeInMemoryDb, type Tables, type Row } from "../helpers/fake-payroll-db";
import { TEST_CHART } from "./fixtures/chart";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import { isBalanced, type ManualEntryLineInput } from "@/lib/accounting/manual-journal";
import {
  createDraftRun,
  recalcRunLines,
  listRuns,
  getRunScope,
  getRunWithLines,
  buildPayrollJournalEntry,
  generateRunJournalEntry,
  softDeleteRun,
  type PayrollRunLineAmounts,
} from "@/lib/accounting/payroll";
import type { PayrollSettings } from "@/lib/accounting/payroll-settings";
import * as payrollTax from "@/lib/accounting/payroll-tax";

/** cast debit/credit (unknown จาก ManualEntryLineInput) → number ก่อนส่งเข้า isBalanced (buildPayrollJournalEntry
 *   สร้างค่าเป็น number เสมอในทางปฏิบัติ — cast นี้แค่ให้ตรงกับ signature ของ isBalanced) */
function toNumericLines(lines: ManualEntryLineInput[]): { debit: number; credit: number }[] {
  return lines.map((l) => ({ debit: Number(l.debit), credit: Number(l.credit) }));
}

/**
 * เทสต์ lib/accounting/payroll.ts (เฟส 9 ส่วน AD, T114-T116)
 *   ★★★ 0.8 จุดที่ต้องพิสูจน์จริงในโค้ด (ไม่ใช่แค่ทฤษฎี): buildPayrollJournalEntry ต้องได้ Dr=Cr เสมอ +
 *   จำนวนบรรทัดคงที่ (~4-6 บรรทัด) ไม่ว่าจะมีพนักงาน 5 คนหรือ 150+ คน
 *   ★★★ 0.9 generateRunJournalEntry ต้อง atomic — เรียกซ้อน 2 ครั้งพร้อมกัน (จำลอง race) → สำเร็จแค่ครั้งเดียว
 */

const PAYROLL_CHART = [
  ...TEST_CHART,
  { code: "2050", name: "เงินสมทบประกันสังคมค้างนำส่ง", category: "หนี้สิน" },
  { code: "5311", name: "เงินสมทบประกันสังคม (ส่วนนายจ้าง)", category: "ค่าใช้จ่าย" },
  { code: "5312", name: "ค่าชดเชยเลิกจ้างพนักงาน", category: "ค่าใช้จ่าย" },
];
const chartByCode = buildChartByCode(PAYROLL_CHART);

const TENANT = "tenant-1";
const CUSTOMER_A = "cust-a";
const CUSTOMER_B = "cust-b";

const DEFAULT_SETTINGS: PayrollSettings = {
  id: "settings-1",
  tenantId: TENANT,
  customerId: CUSTOMER_A,
  salaryExpenseAccountCode: "5310",
  ssoEmployerExpenseAccountCode: "5311",
  ssoPayableAccountCode: "2050",
  pitPayableAccountCode: "2910",
  otherDeductionsAccountCode: "2015",
  netPayAccountCode: "2040",
  netPayIsPaidImmediately: false,
  payFrequency: "monthly",
  severanceExpenseAccountCode: "5312",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function baseTables(): Tables {
  return {
    payroll_employees: [],
    payroll_runs: [],
    payroll_run_lines: [],
    pit_tax_brackets: [
      { id: "b1", effective_from: "2017-01-01", bracket_order: 1, income_from: 0, income_to: 150000, rate_percent: 0 },
      { id: "b2", effective_from: "2017-01-01", bracket_order: 2, income_from: 150001, income_to: 300000, rate_percent: 5 },
      { id: "b3", effective_from: "2017-01-01", bracket_order: 3, income_from: 300001, income_to: 500000, rate_percent: 10 },
      { id: "b4", effective_from: "2017-01-01", bracket_order: 4, income_from: 500001, income_to: 750000, rate_percent: 15 },
      { id: "b5", effective_from: "2017-01-01", bracket_order: 5, income_from: 750001, income_to: 1000000, rate_percent: 20 },
      { id: "b6", effective_from: "2017-01-01", bracket_order: 6, income_from: 1000001, income_to: 2000000, rate_percent: 25 },
      { id: "b7", effective_from: "2017-01-01", bracket_order: 7, income_from: 2000001, income_to: 5000000, rate_percent: 30 },
      { id: "b8", effective_from: "2017-01-01", bracket_order: 8, income_from: 5000001, income_to: null, rate_percent: 35 },
    ],
    // ★ effective_from เป็นปี ค.ศ. จริงเสมอ (1997/2026 = พ.ศ. 2540/2569) — ดูคอมเมนต์แก้บั๊กใน migration 0079
    sso_contribution_config: [
      { id: "s1", effective_from: "1997-01-01", employee_rate_percent: 5, employer_rate_percent: 5, wage_floor: 1650, wage_ceiling: 15000 },
      { id: "s2", effective_from: "2026-01-01", employee_rate_percent: 5, employer_rate_percent: 5, wage_floor: 1650, wage_ceiling: 17500 },
    ],
    // ★ แถวดิบต้องเป็น snake_case ตรงกับคอลัมน์ DB จริง (payroll-settings.ts::mapRow อ่านจากคีย์เหล่านี้)
    //   — ไม่ spread DEFAULT_SETTINGS (camelCase, เป็น TS type สำหรับผลลัพธ์ที่ map แล้ว) ตรง ๆ
    payroll_settings: [
      {
        id: DEFAULT_SETTINGS.id,
        tenant_id: TENANT,
        customer_id: CUSTOMER_A,
        salary_expense_account_code: DEFAULT_SETTINGS.salaryExpenseAccountCode,
        sso_employer_expense_account_code: DEFAULT_SETTINGS.ssoEmployerExpenseAccountCode,
        sso_payable_account_code: DEFAULT_SETTINGS.ssoPayableAccountCode,
        pit_payable_account_code: DEFAULT_SETTINGS.pitPayableAccountCode,
        other_deductions_account_code: DEFAULT_SETTINGS.otherDeductionsAccountCode,
        net_pay_account_code: DEFAULT_SETTINGS.netPayAccountCode,
        net_pay_is_paid_immediately: DEFAULT_SETTINGS.netPayIsPaidImmediately,
        pay_frequency: DEFAULT_SETTINGS.payFrequency,
        severance_expense_account_code: DEFAULT_SETTINGS.severanceExpenseAccountCode,
        created_at: DEFAULT_SETTINGS.createdAt,
        updated_at: DEFAULT_SETTINGS.updatedAt,
      },
    ],
    manual_journal_entries: [],
    manual_journal_entry_lines: [],
    chart_of_accounts: PAYROLL_CHART.map((a, i) => ({
      code: a.code,
      name: a.name,
      category: a.category,
      is_bank: false,
      is_active: true,
      deleted_at: null,
      sort_order: i,
      tenant_id: TENANT,
    })),
  };
}

function seedEmployees(tables: Tables, n: number, customerId = CUSTOMER_A): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `emp-${i}`;
    tables.payroll_employees.push({
      id,
      tenant_id: TENANT,
      customer_id: customerId,
      employee_code: `E${i}`,
      full_name: `พนักงาน ${i}`,
      id_card_no: null,
      passport_no: "P" + i,
      position: null,
      base_salary: 20000,
      start_date: null,
      resign_date: null,
      is_active: true,
      deleted_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    ids.push(id);
  }
  return ids;
}

describe("createDraftRun (T114)", () => {
  let tables: Tables;
  beforeEach(() => {
    tables = baseTables();
  });

  it("สร้างรอบใหม่ + prefill บรรทัดจากพนักงาน active ทั้งหมด (gross = base_salary)", async () => {
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, 5);
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    expect(res.ok).toBe(true);
    expect(tables.payroll_run_lines).toHaveLength(5);
    expect(tables.payroll_run_lines.every((l) => l.gross_salary === 20000)).toBe(true);
  });

  // ★★★ เฟส 9b กลุ่ม BB (T130) — auto-prorate ตอน prefill
  it("★ BB: พนักงานทุกคนทำงานเต็มเดือน (ไม่มีใครเข้า/ออกกลางเดือน) → prefill เหมือนก่อนเฟส 9b เป๊ะ (regression-safe)", async () => {
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, 5);
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    expect(res.ok).toBe(true);
    expect(tables.payroll_run_lines.every((l) => l.gross_salary === 20000)).toBe(true);
  });

  it("★ BB: พนักงานเข้าใหม่กลางเดือน (start_date ตกในเดือนของรอบ) → prefill ต่ำกว่า base_salary ตามสัดส่วนวันทำงาน", async () => {
    const { db } = makeInMemoryDb(tables);
    const ids = seedEmployees(tables, 1);
    const empRow = tables.payroll_employees.find((r) => r.id === ids[0])!;
    empRow.start_date = "2026-08-16"; // เข้าใหม่ 16 ส.ค. 2569(ค.ศ.2026, ส.ค.=31 วัน) → daysWorked=16
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-31" });
    expect(res.ok).toBe(true);
    const line = tables.payroll_run_lines[0];
    // 20000/31*16 = 10322.58
    expect(line.gross_salary).toBe(10322.58);
  });

  it("★ BB: พนักงานลาออกกลางเดือน (resign_date ตกในเดือนของรอบ) → prefill ตามสัดส่วนวันทำงาน", async () => {
    const { db } = makeInMemoryDb(tables);
    const ids = seedEmployees(tables, 1);
    const empRow = tables.payroll_employees.find((r) => r.id === ids[0])!;
    empRow.resign_date = "2026-08-10"; // ลาออกวันที่ 10 ส.ค. → daysWorked=10/31
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    expect(res.ok).toBe(true);
    const line = tables.payroll_run_lines[0];
    expect(line.gross_salary).toBe(Math.round((20000 / 31) * 10 * 100) / 100);
  });

  it("★ พนักงาน 150+ คน (mock) → สร้างบรรทัดครบทุกคนไม่ตกหล่น, ใช้ query แบบ chunk ไม่ error", async () => {
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, 180);
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    expect(res.ok).toBe(true);
    expect(tables.payroll_run_lines).toHaveLength(180);
  });

  it("ไม่มีพนักงาน active เลย (ทั้งหมด inactive) → สร้างรอบได้ แต่ไม่มีบรรทัด", async () => {
    const { db } = makeInMemoryDb(tables);
    const ids = seedEmployees(tables, 3);
    for (const id of ids) {
      const row = tables.payroll_employees.find((r) => r.id === id)!;
      row.is_active = false;
    }
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    expect(res.ok).toBe(true);
    expect(tables.payroll_run_lines).toHaveLength(0);
  });

  it("★ สร้างรอบเดือน/ปีเดียวกันซ้ำ (unique) → ถูกปฏิเสธ (simulation)", async () => {
    const uniqueIndexes = [
      { table: "payroll_runs", columns: ["tenant_id", "customer_id", "pay_period_year", "pay_period_month"], where: (r: Row) => !r.deleted_at },
    ];
    const { db } = makeInMemoryDb(tables, { uniqueIndexes });
    const first = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    expect(first.ok).toBe(true);
    const second = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-15" });
    expect(second.ok).toBe(false);
  });

  it("input ผิดรูปแบบ (เดือนเกิน 12) → ปฏิเสธ ไม่แตะ DB", async () => {
    const { db } = makeInMemoryDb(tables);
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 13, payDate: "2026-08-10" });
    expect(res.ok).toBe(false);
    expect(tables.payroll_runs).toHaveLength(0);
  });

  // ★★ แก้บั๊ก QC เฟส 9 (ปัญหาที่ 2): เดิม insert บรรทัด prefill ไม่เช็ค error — chunk ล้มเหลวแล้วฟังก์ชันยังคืน
  //   สำเร็จปกติทำให้รอบเงินเดือนขาดพนักงานไปแบบไม่มีใครรู้ — ตอนนี้ต้องคืน ok:false + rollback รอบที่สร้างไปแล้ว
  it("★★ insert บรรทัดพนักงานล้มเหลว (DB error จำลอง) → คืน ok:false ไม่ใช่สำเร็จเงียบ ๆ + rollback รอบที่สร้างไปแล้ว", async () => {
    const { db, forceErrors } = makeInMemoryDb(tables);
    seedEmployees(tables, 5);
    forceErrors.push({ table: "payroll_run_lines", mode: "insert", message: "DB error ชั่วคราว (จำลองเทสต์)" });
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    expect(res.ok).toBe(false);
    // ★ ไม่มีบรรทัดพนักงานตกหล่นค้างอยู่ — insert ล้มเหลวทั้ง chunk ไม่มีบรรทัดถูกสร้างเลย
    expect(tables.payroll_run_lines).toHaveLength(0);
    // ★ รอบที่สร้างไปแล้วต้องถูก rollback (soft-delete) กันสภาพข้อมูลครึ่ง ๆ กลาง ๆ ค้างเป็น draft ใช้งานได้
    const runRow = tables.payroll_runs[0];
    expect(runRow.deleted_at).toBeTruthy();
  });
});

describe("recalcRunLines (T114) — idempotent", () => {
  let tables: Tables;
  let runId: string;

  beforeEach(async () => {
    tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, 3);
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    runId = (res as { id: string }).id;
  });

  it("คำนวณ pit/sso/net ต่อบรรทัดถูกต้อง (เทียบมือ: เงินเดือน 20,000/เดือน)", async () => {
    const { db } = makeInMemoryDb(tables);
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.lineCount).toBe(3);
    const line = tables.payroll_run_lines[0];
    // annual=240000, expense=100000(cap), allowance=60000 → taxable=80000 → tax ทั้งปี=0 (ต่ำกว่าขั้นแรก) → pit=0
    expect(line.pit_withheld).toBe(0);
    // pay_date=2026-08-10 → ใช้ config ล่าสุด (effective_from 2026-01-01, ceiling 17,500)
    // sso: wage=20000 > ceiling17500 → base=17500 → employee/employer = 875 ต่อคน
    expect(line.sso_employee).toBe(875);
    expect(line.sso_employer).toBe(875);
    expect(line.net_pay).toBe(20000 - 0 - 875 - 0);
  });

  it("เรียกซ้ำ 2 ครั้งด้วยข้อมูลเดียวกัน → ผลลัพธ์เหมือนกันเป๊ะ (deterministic)", async () => {
    const { db } = makeInMemoryDb(tables);
    await recalcRunLines(db, TENANT, CUSTOMER_A, runId);
    const snapshot1 = JSON.stringify(tables.payroll_run_lines);
    await recalcRunLines(db, TENANT, CUSTOMER_A, runId);
    const snapshot2 = JSON.stringify(tables.payroll_run_lines);
    expect(snapshot1).toBe(snapshot2);
  });

  it("แก้ยอด gross ต่อบรรทัดผ่าน lineEdits → บันทึกแล้วคำนวณตามยอดใหม่", async () => {
    const { db } = makeInMemoryDb(tables);
    const lineId = tables.payroll_run_lines[0].id as string;
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
      { id: lineId, grossSalary: 50000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0 },
    ]);
    expect(res.ok).toBe(true);
    const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
    expect(line.gross_salary).toBe(50000);
  });

  // ★★★ เฟส 9b กลุ่ม BA (T126, 0.3) — ยกเว้นเงินสมทบประกันสังคมรายพนักงาน
  it("★★★ BA: พนักงาน sso_exempt=true → sso_employee/sso_employer=0 เสมอไม่ว่าค่าจ้างเท่าไหร่", async () => {
    const { db } = makeInMemoryDb(tables);
    const empId = tables.payroll_run_lines[0].payroll_employee_id as string;
    const empRow = tables.payroll_employees.find((r) => r.id === empId)!;
    empRow.sso_exempt = true;
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId);
    expect(res.ok).toBe(true);
    const line = tables.payroll_run_lines.find((l) => l.payroll_employee_id === empId)!;
    expect(line.sso_employee).toBe(0);
    expect(line.sso_employer).toBe(0);
    // net_pay ต้องไม่ถูกหัก sso_employee (คำนวณจาก gross - pit - 0 - other_deductions)
    expect(line.net_pay).toBe(Number(line.gross_salary) - Number(line.pit_withheld));
  });

  it("★★★ BA: พนักงานอื่นในรอบเดียวกันที่ sso_exempt=false ยังคำนวณ SSO ปกติ ไม่ถูกกระทบจากคนที่ยกเว้น", async () => {
    const { db } = makeInMemoryDb(tables);
    const exemptEmpId = tables.payroll_run_lines[0].payroll_employee_id as string;
    tables.payroll_employees.find((r) => r.id === exemptEmpId)!.sso_exempt = true;
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId);
    expect(res.ok).toBe(true);
    const otherLine = tables.payroll_run_lines.find((l) => l.payroll_employee_id !== exemptEmpId)!;
    // เงินเดือน 20000 > ceiling 17500 → sso_employee/employer = 875 ตามปกติ (เหมือนเทสต์ไม่มี BA)
    expect(otherLine.sso_employee).toBe(875);
    expect(otherLine.sso_employer).toBe(875);
  });

  it("★ BA: sso_exempt=false (ปกติ, ค่า default) → คำนวณ SSO ตามปกติเหมือนก่อนเฟส 9b เป๊ะ (regression-safe)", async () => {
    const { db } = makeInMemoryDb(tables);
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId);
    expect(res.ok).toBe(true);
    expect(tables.payroll_run_lines.every((l) => l.sso_employee === 875 && l.sso_employer === 875)).toBe(true);
  });

  // ★★ 0.5 โบนัส verify แล้ว/เปิดใช้งานจริง (T112) — เทียบมือตามสูตร calcMonthlyPitWithBonus (ป.96/2543
  //   ข้อ 1(5), ดู golden test เต็มใน payroll-tax.test.ts): gross=60,000/เดือน, periods=12,
  //   allowance=PERSONAL_ALLOWANCE_STANDARD=60,000, bonus=90,000
  //   A: annual=720,000, expense cap=100,000, taxable=720,000-100,000-60,000=560,000
  //      tax=7,500+20,000+60,000*15%(9,000)=36,500 → regularPit=36,500/12=3,041.67
  //   B: annualB=810,000, expenseB cap=100,000, taxableB=810,000-100,000-60,000=650,000
  //      tax=7,500+20,000+150,000*15%(22,500)=50,000 → bonusPit=50,000-36,500=13,500
  //   totalPit=3,041.67+13,500=16,541.67
  //   sso: wage=60,000(grossThisPeriod ไม่รวม bonus)>ceiling 17,500 → base=17,500 → employee/employer=875
  //   net_pay = 60,000+90,000-16,541.67-875-0 = 132,583.33
  it("★★ 0.5 bonus_amount > 0 เปิดใช้งานแล้ว — คำนวณภาษีโบนัสตาม ป.96/2543 ข้อ 1(5) ถูกต้องตรงกับเทียบมือ", async () => {
    const { db } = makeInMemoryDb(tables);
    const lineId = tables.payroll_run_lines[0].id as string;
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
      { id: lineId, grossSalary: 60000, otherAdditions: 0, bonusAmount: 90000, otherDeductions: 0 },
    ]);
    expect(res.ok).toBe(true);
    const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
    expect(line.bonus_amount).toBe(90000);
    expect(line.pit_withheld).toBe(16541.67);
    expect(line.sso_employee).toBe(875);
    expect(line.sso_employer).toBe(875);
    expect(line.net_pay).toBe(132583.33);
  });

  it("★ โบนัส=0 (ปกติ) → pit เท่ากับ calcMonthlyPitForRegularIncome เดิมทุกประการ ไม่ถูกกระทบจากฟีเจอร์ใหม่", async () => {
    const { db } = makeInMemoryDb(tables);
    const lineId = tables.payroll_run_lines[0].id as string;
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
      { id: lineId, grossSalary: 60000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0 },
    ]);
    expect(res.ok).toBe(true);
    const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
    // annual=720000, expense cap100000, allowance60000, taxable=560000 → tax=36500 → /12=3041.67 (เหมือน regularPit ข้างบน)
    expect(line.pit_withheld).toBe(3041.67);
  });

  it("★ edge case: พนักงานเข้าใหม่กลางปีได้โบนัสด้วย — regularPit หารด้วย remainingPeriodsInYear แต่ bonusPit ไม่หาร", async () => {
    const { db } = makeInMemoryDb(tables);
    const empId = tables.payroll_run_lines[0].payroll_employee_id as string;
    const empRow = tables.payroll_employees.find((r) => r.id === empId)!;
    empRow.start_date = "2026-07-01"; // เข้าใหม่ ก.ค. ปีเดียวกับ pay_date (2026-08-10) → periods=6
    const lineId = tables.payroll_run_lines[0].id as string;
    // gross=100,000, periods=6, allowance=60,000, bonus=100,000 → ดู golden test เต็มใน payroll-tax.test.ts
    // regularPit=3,583.33, bonusPit=12,000 (ไม่หารด้วย periods) → totalPit=15,583.33
    await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
      { id: lineId, grossSalary: 100000, otherAdditions: 0, bonusAmount: 100000, otherDeductions: 0 },
    ]);
    const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
    expect(line.pit_withheld).toBe(15583.33);
  });

  it("★ พนักงานเข้าใหม่กลางปี — remainingPeriodsInYear ≠ 12 มีผลต่อ pit ที่คำนวณได้", async () => {
    const { db } = makeInMemoryDb(tables);
    const empId = tables.payroll_run_lines[0].payroll_employee_id as string;
    const empRow = tables.payroll_employees.find((r) => r.id === empId)!;
    empRow.start_date = "2026-07-01"; // เข้าใหม่ ก.ค. ปีเดียวกับ pay_date (2026-08-10) → periods=6
    const lineId = tables.payroll_run_lines[0].id as string;
    await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
      { id: lineId, grossSalary: 100000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0 },
    ]);
    const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
    // periods=6, annual=600000, expense cap100000, allowance60000, taxable=440000
    // tax = 7500+14000=21500 → /6 = 3583.33
    expect(line.pit_withheld).toBe(3583.33);
  });

  it("ปฏิเสธถ้ารอบ status='finalized' แล้ว (ล็อกแก้/คำนวณซ้ำ)", async () => {
    const { db } = makeInMemoryDb(tables);
    const runRow = tables.payroll_runs.find((r) => r.id === runId)!;
    runRow.status = "finalized";
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId);
    expect(res.ok).toBe(false);
  });

  it("ลูกค้าไม่ตรง → ปฏิเสธ", async () => {
    const { db } = makeInMemoryDb(tables);
    const res = await recalcRunLines(db, TENANT, CUSTOMER_B, runId);
    expect(res.ok).toBe(false);
  });

  // ★★ แก้บั๊ก QC เฟส 9 (ปัญหาที่ 1ข): ป้องกันที่ต้นเหตุ — net_pay ต่อพนักงานติดลบ (other_deductions มากกว่า
  //   รายรับสุทธิ) ต้องถูกปฏิเสธตั้งแต่ recalcRunLines ไม่ปล่อยให้บันทึกลง DB แล้วไปพังตอนสร้าง JE ทีหลัง
  it("★★ other_deductions มากกว่ารายรับสุทธิ (net_pay จะติดลบ) → ปฏิเสธพร้อมชื่อพนักงาน+สาเหตุชัดเจน ไม่บันทึกผลคำนวณ", async () => {
    const { db } = makeInMemoryDb(tables);
    const lineId = tables.payroll_run_lines[0].id as string;
    // gross=20000, sso_employee=875 (คำนวณจาก wage 20000 > ceiling 17500), pit=0 → other_deductions=25000
    // ทำให้ net_pay = 20000-0-875-25000 = -5875 < 0
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
      { id: lineId, grossSalary: 20000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 25000 },
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("พนักงาน 0");
      expect(res.message).toContain("ติดลบ");
    }
    // ★ ผลคำนวณ pit/sso/net_pay ต้องไม่ถูกบันทึกเลย (ยังเป็นค่าเริ่มต้น 0 จาก createDraftRun) — ไม่ปล่อยครึ่ง ๆ กลาง ๆ
    const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
    expect(line.net_pay).toBe(0);
    expect(line.pit_withheld).toBe(0);
  });

  // ★★ แก้บั๊ก QC เฟส 9 (ปัญหาที่ 2): เดิม loop update ยอดที่แก้ต่อบรรทัดไม่เช็ค error — ถ้า update ล้มเหลว
  //   ฟังก์ชันยังคืนสำเร็จเหมือนบันทึกครบทุกบรรทัด (silent error swallowing)
  it("★★ update ยอดที่แก้ (lineEdits) ล้มเหลว (DB error จำลอง) → คืน ok:false ไม่ใช่สำเร็จเงียบ ๆ", async () => {
    const { db, forceErrors } = makeInMemoryDb(tables);
    const lineId = tables.payroll_run_lines[0].id as string;
    forceErrors.push({ table: "payroll_run_lines", mode: "update", message: "DB error ชั่วคราว (จำลองเทสต์)" });
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
      { id: lineId, grossSalary: 50000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0 },
    ]);
    expect(res.ok).toBe(false);
    // ★ ยอดเดิมต้องไม่เปลี่ยน — update ล้มเหลวจริง ไม่ใช่บันทึกไปแล้วแค่ลืมเช็ค error
    const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
    expect(line.gross_salary).toBe(20000);
  });

  // ★★ แก้บั๊ก QC เฟส 9 (ปัญหาที่ 2): เดิม loop update ผล pit/sso/net ต่อบรรทัดไม่เช็ค error เช่นกัน
  it("★★ update ผลคำนวณ pit/sso/net ล้มเหลว (DB error จำลอง) → คืน ok:false ไม่ใช่สำเร็จเงียบ ๆ", async () => {
    const { db, forceErrors } = makeInMemoryDb(tables);
    // ★ ไม่ส่ง lineEdits (array ว่าง) → loop แรกไม่ถูกเรียกเลย บังคับ error ตกที่ loop คำนวณ pit/sso/net โดยเฉพาะ
    forceErrors.push({ table: "payroll_run_lines", mode: "update", message: "DB error ชั่วคราว (จำลองเทสต์)" });
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId);
    expect(res.ok).toBe(false);
    const line = tables.payroll_run_lines[0];
    expect(line.pit_withheld).toBe(0);
    expect(line.net_pay).toBe(0);
  });

  // ★★★ เฟส 9b กลุ่ม BF (T164, ★★★ 0.2 gate) — ค่าตอบแทนเลิกจ้าง/ชดเชย
  describe("★★★ BF: severance_amount/severance_pit_withheld (0.2 gate — ENABLE_SEVERANCE_TAX_CALC=true ตั้งแต่ 2026-08-12, แต่พนักงานกลุ่มนี้ไม่มี start_date → years=0<5 → hard-gated เป็น 0 เสมอไม่ว่า flag จะเป็นอะไร)", () => {
    it("กรอก severance_amount > 0 แต่พนักงานไม่มี start_date (years=0<5) → severance_pit_withheld ต้องเป็น 0 เสมอ (hard-gate ไม่ใช่แค่ flag)", async () => {
      const { db } = makeInMemoryDb(tables);
      const lineId = tables.payroll_run_lines[0].id as string;
      const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 20000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0, severanceAmount: 700000 },
      ]);
      expect(res.ok).toBe(true);
      const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
      expect(line.severance_amount).toBe(700000);
      expect(line.severance_pit_withheld).toBe(0);
      // ★ net_pay ต้องรวม severance_amount เข้าไปด้วย (บวกเต็มจำนวนเพราะ severance_pit_withheld=0)
      expect(line.net_pay).toBe(Number(line.gross_salary) + 700000 - Number(line.pit_withheld) - Number(line.sso_employee));
    });

    it("severanceAmount undefined (ไม่ส่งมา — backward compatible กับ lineEdits เดิมก่อนเฟสนี้) → default 0 ไม่ throw", async () => {
      const { db } = makeInMemoryDb(tables);
      const lineId = tables.payroll_run_lines[0].id as string;
      const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 20000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0 },
      ]);
      expect(res.ok).toBe(true);
      const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
      expect(line.severance_amount).toBe(0);
      expect(line.severance_pit_withheld).toBe(0);
    });

    it("severanceAmount ติดลบ → ปฏิเสธ (validate เหมือนช่องเงินอื่น ๆ)", async () => {
      const { db } = makeInMemoryDb(tables);
      const lineId = tables.payroll_run_lines[0].id as string;
      const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 20000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0, severanceAmount: -100 },
      ]);
      expect(res.ok).toBe(false);
    });

    it("★ กฎเหล็ก — แก้ severance_amount ไม่กระทบ pit_withheld ของเงินเดือน/โบนัสปกติเลย (แยกสูตรกันเด็ดขาด)", async () => {
      const { db } = makeInMemoryDb(tables);
      const lineId = tables.payroll_run_lines[0].id as string;
      // baseline: ไม่มี severance
      await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 60000, otherAdditions: 0, bonusAmount: 90000, otherDeductions: 0 },
      ]);
      const baselinePit = tables.payroll_run_lines.find((l) => l.id === lineId)!.pit_withheld;
      expect(baselinePit).toBe(16541.67); // เทียบเท่าเทสต์ 0.5 เดิมด้านบน (ไม่ถูกกระทบจาก severance เลย)

      // เพิ่ม severance_amount เข้าไปในบรรทัดเดียวกัน — pit_withheld (เงินเดือน/โบนัส) ต้องเท่าเดิมเป๊ะ
      await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 60000, otherAdditions: 0, bonusAmount: 90000, otherDeductions: 0, severanceAmount: 500000 },
      ]);
      const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
      expect(line.pit_withheld).toBe(baselinePit);
      expect(line.severance_amount).toBe(500000);
      expect(line.severance_pit_withheld).toBe(0); // years=0<5 (ไม่มี start_date) → hard-gated เสมอ ไม่เกี่ยวกับ flag
    });

    it("★★★★★ 2026-08-12 — flag=true จริง + อายุงาน ≥5 ปี → severance_pit_withheld คำนวณจริงตามสูตร golden test (verify ร่วมกับผู้ใช้)", async () => {
      const { db } = makeInMemoryDb(tables);
      const empId = tables.payroll_run_lines[0].payroll_employee_id as string;
      tables.payroll_employees.find((r) => r.id === empId)!.start_date = "2016-08-10"; // เข้างาน 2016-08-10 → ถึง resign 2026-08-10 = 10 ปีพอดี
      tables.payroll_employees.find((r) => r.id === empId)!.resign_date = "2026-08-10";
      const lineId = tables.payroll_run_lines[0].id as string;
      const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 45000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0, severanceAmount: 1000000 },
      ]);
      expect(res.ok).toBe(true);
      const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
      // ตรงกับ golden test เดียวกันใน payroll-tax.test.ts เป๊ะ: exempt 600,000 → taxable 400,000 → expense 7,000×10=70,000
      // → remainder 330,000 → netTaxable 165,000 → tax 8,250 (ไม่มีขั้นยกเว้น 0-150,000 สำหรับมาตรา 48(5))
      expect(line.severance_pit_withheld).toBe(8250);
      expect(line.severance_amount).toBe(1000000);
    });
  });
});

// ★★★ เฟส 9b กลุ่ม BE (0.2 ★★★ gate, T154/T156) — ค่าลดหย่อนภาษีอื่นต้องไม่กระทบยอดจริงเลยตราบใด flag=false
//   (regression-safe 100%) และต้องกระทบยอดจริงถูกต้องตามสูตร T152 เมื่อ flag=true เท่านั้น
describe("recalcRunLines — เฟส 9b กลุ่ม BE (0.2 gate, T154)", () => {
  let tables: Tables;
  let runId: string;
  let empId: string;
  let lineId: string;

  beforeEach(async () => {
    tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, 1);
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    runId = (res as { id: string }).id;
    lineId = tables.payroll_run_lines[0].id as string;
    empId = tables.payroll_run_lines[0].payroll_employee_id as string;
  });

  function seedDeduction(taxYear: number, deductionType: string, amount: number) {
    tables.payroll_employee_deductions ??= [];
    tables.payroll_employee_deductions.push({
      id: `ded-${tables.payroll_employee_deductions.length}`,
      tenant_id: TENANT,
      payroll_employee_id: empId,
      tax_year: taxYear,
      deduction_type: deductionType,
      amount,
      note: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
  }

  it("★★★ flag=false (บังคับปิดผ่าน spy — ค่า default จริงเปิดแล้วตั้งแต่ 2026-08-12) → pit_withheld เท่ากับก่อนเฟสนี้เป๊ะแม้มีข้อมูล deductions อยู่ในตาราง (regression-safe 100%)", async () => {
    const spy = vi.spyOn(payrollTax, "ENABLE_EXTRA_DEDUCTIONS_IN_PIT", "get").mockReturnValue(false);
    try {
      // gross=60,000 (เหมือนเทสต์โบนัสด้านบน) → pit ไม่มี deductions = 3,041.67 ตามสูตรเดิม
      const { db } = makeInMemoryDb(tables);
      seedDeduction(2569, "mortgage_interest", 50000);
      const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 60000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0 },
      ]);
      expect(res.ok).toBe(true);
      const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
      // ★ ต้องเท่ากับยอดที่คำนวณได้ก่อนเฟสนี้ (ไม่มีค่าลดหย่อนอื่นเลย) เป๊ะ — เทียบกับเทสต์ "โบนัส=0" ด้านบน
      expect(line.pit_withheld).toBe(3041.67);
    } finally {
      spy.mockRestore();
    }
  });

  it("★★★ flag=true (ค่า default จริงตั้งแต่ 2026-08-12) → pit_withheld ลดลงตามค่าลดหย่อนที่เพิ่มถูกต้องตามสูตร T152", async () => {
    const spy = vi.spyOn(payrollTax, "ENABLE_EXTRA_DEDUCTIONS_IN_PIT", "get").mockReturnValue(true);
    try {
      const { db } = makeInMemoryDb(tables);
      seedDeduction(2569, "mortgage_interest", 50000);
      const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 60000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0 },
      ]);
      expect(res.ok).toBe(true);
      const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
      // ★ เทียบมือ: annual=720,000, expense cap=100,000, allowance=60,000+50,000(mortgage_interest,ไม่ชนเพดาน
      //   100,000)=110,000 → taxable=510,000 → tax = 0(0-150k) + 7,500(150k-300k@5%) + 20,000(300k-500k@10%)
      //   + 1,500(500k-510k@15%) = 29,000 → pit = 29,000/12 = 2,416.67 (ลดลงจาก 3,041.67 พอดี 625 = ผลต่าง
      //   ค่าลดหย่อน 50,000 บาท × 15% (bracket เดิมที่ taxable เดิมตกอยู่) ÷ 12 งวด)
      expect(line.pit_withheld).toBe(2416.67);
      expect(3041.67 - 2416.67).toBe(625);
    } finally {
      spy.mockRestore();
    }
  });

  it("★★★ 2026-08-12 golden test — flag=true จริง + provident_fund เกิน 10,000 → ส่วนเกินหักเป็น exemptIncome ก่อนค่าใช้จ่ายจริง (แก้บั๊กสถาปัตยกรรม PVD)", async () => {
    const spy = vi.spyOn(payrollTax, "ENABLE_EXTRA_DEDUCTIONS_IN_PIT", "get").mockReturnValue(true);
    try {
      const { db } = makeInMemoryDb(tables);
      seedDeduction(2569, "provident_fund", 30000);
      const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 60000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0 },
      ]);
      expect(res.ok).toBe(true);
      const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
      // เทียบมือ: annual=720,000 (30%=216,000 > pvdSum 30,000 → ไม่ชนเพดานรวม), pvdPostExpense=10,000
      // (allowance), pvdExempt=20,000 (หักก่อนค่าใช้จ่าย) → incomeAfterExemption=700,000
      // expense=min(350,000,100,000)=100,000 (ชน cap) → allowance=60,000+10,000=70,000
      // taxable=700,000-100,000-70,000=530,000 → tax=7,500+20,000+4,500(500k-530k@15%)=32,000 → pit=32,000/12=2,666.67
      expect(line.pit_withheld).toBe(2666.67);
      // ★ เคสนี้ taxable บังเอิญเท่ากับวิธีเดิมพอดี (expense ชน cap 100,000 ทั้งสองวิธี ทำให้
      //   exempt+allowance ใหม่ = allowance เดิมทั้งก้อนเสมอ) — พิสูจน์ความ self-consistent ของสูตรใหม่/
      //   การ wiring ผ่าน recalcRunLines เท่านั้น ไม่พิสูจน์ว่าต่างจากสูตรเดิม (ดู golden test แยกที่พิสูจน์
      //   ความต่างจริงใน payroll-tax.test.ts/payroll-deductions.test.ts ที่ expense ยังไม่ชน cap — 180k/27k)
    } finally {
      spy.mockRestore();
    }
  });

  it("flag=true แต่ไม่มีแถว payroll_employee_deductions ของปีภาษีนี้เลย → personalAllowance ยังเท่ากับ PERSONAL_ALLOWANCE_STANDARD เป๊ะ (ค่า default ของลูกค้าทุกรายก่อนกรอกข้อมูลเพิ่ม)", async () => {
    const spy = vi.spyOn(payrollTax, "ENABLE_EXTRA_DEDUCTIONS_IN_PIT", "get").mockReturnValue(true);
    try {
      const { db } = makeInMemoryDb(tables);
      const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 60000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0 },
      ]);
      expect(res.ok).toBe(true);
      const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
      expect(line.pit_withheld).toBe(3041.67);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * ★★★★★ 2026-08-12 combined golden test (ก่อนเปิด ENABLE_EXTRA_DEDUCTIONS_IN_PIT เป็น default จริง) — ทุก
   * ประเภทค่าลดหย่อนพร้อมกันของพนักงานคนเดียว end-to-end ผ่าน recalcRunLines จริง (ไม่ใช่แค่ทดสอบ
   * sumAndCapDeductions โดดๆ) — ยอดแต่ละประเภทตรงกับ combined golden test คู่กันใน
   * payroll-deductions.test.ts (totalOtherAllowance=370,000, pvdExemptPortion=17,000):
   *   annual=720,000, exemptIncome=17,000 → incomeAfterExemption=703,000
   *   expense=min(351,500,100,000)=100,000 (ชน cap) → allowance=60,000(standard)+370,000=430,000
   *   taxable=703,000-100,000-430,000=173,000 → tax=(173,000-150,000)×5%=1,150 → pit=1,150/12=95.83
   */
  it("★★★★★ combined golden test — 6 ประเภทค่าลดหย่อนพร้อมกัน end-to-end ผ่าน recalcRunLines จริง", async () => {
    const spy = vi.spyOn(payrollTax, "ENABLE_EXTRA_DEDUCTIONS_IN_PIT", "get").mockReturnValue(true);
    try {
      const { db } = makeInMemoryDb(tables);
      seedDeduction(2569, "spouse_no_income", 60000);
      seedDeduction(2569, "child", 30000);
      seedDeduction(2569, "child", 60000);
      seedDeduction(2569, "life_insurance_self", 100000);
      seedDeduction(2569, "life_insurance_spouse", 10000);
      seedDeduction(2569, "provident_fund", 27000);
      seedDeduction(2569, "mortgage_interest", 100000);
      const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 60000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0 },
      ]);
      expect(res.ok).toBe(true);
      const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
      expect(line.pit_withheld).toBe(95.83);
      expect(3041.67 - 95.83).toBeGreaterThan(0); // ลดลงจริงเทียบกับไม่มีค่าลดหย่อนเลย (sanity)
    } finally {
      spy.mockRestore();
    }
  });

  it("deductions ของปีภาษีอื่น (ไม่ตรงกับ pay_period_year ของรอบนี้) → ไม่ถูกนำมาคำนวณ", async () => {
    const spy = vi.spyOn(payrollTax, "ENABLE_EXTRA_DEDUCTIONS_IN_PIT", "get").mockReturnValue(true);
    try {
      const { db } = makeInMemoryDb(tables);
      seedDeduction(2568, "mortgage_interest", 50000); // ปีภาษีอื่น ไม่ใช่ 2569 ของรอบนี้
      const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
        { id: lineId, grossSalary: 60000, otherAdditions: 0, bonusAmount: 0, otherDeductions: 0 },
      ]);
      expect(res.ok).toBe(true);
      const line = tables.payroll_run_lines.find((l) => l.id === lineId)!;
      expect(line.pit_withheld).toBe(3041.67);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("getRunWithLines — เฟส 9b กลุ่ม BE (0.2 gate, T154/T155) — personalAllowancePreview", () => {
  let tables: Tables;
  let runId: string;
  let empId: string;
  let lineId: string;

  beforeEach(async () => {
    tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, 1);
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    runId = (res as { id: string }).id;
    lineId = tables.payroll_run_lines[0].id as string;
    empId = tables.payroll_run_lines[0].payroll_employee_id as string;
  });

  it("ไม่มี deductions เลย → personalAllowancePreview เท่ากับ PERSONAL_ALLOWANCE_STANDARD (60,000) เป๊ะ, extraDeductionsPreviewTotal=0", async () => {
    const { db } = makeInMemoryDb(tables);
    const detail = await getRunWithLines(db, TENANT, CUSTOMER_A, runId);
    expect(detail).not.toBeNull();
    const line = detail!.lines.find((l) => l.id === lineId)!;
    expect(line.personalAllowancePreview).toBe(60000);
    expect(line.extraDeductionsPreviewTotal).toBe(0);
    expect(line.deductionWarnings).toEqual([]);
  });

  it("มี deductions ของปีภาษีของรอบนี้ → personalAllowancePreview รวมค่าลดหย่อนหลัง cap เข้าไปด้วย (แสดงในหน้าจอเสมอไม่ว่า flag เปิด/ปิด)", async () => {
    tables.payroll_employee_deductions ??= [];
    tables.payroll_employee_deductions.push({
      id: "ded-x",
      tenant_id: TENANT,
      payroll_employee_id: empId,
      tax_year: 2569,
      deduction_type: "spouse_no_income",
      amount: 90000, // เกินเพดาน 60,000 → ต้องถูกตัด + มี warning
      note: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const { db } = makeInMemoryDb(tables);
    const detail = await getRunWithLines(db, TENANT, CUSTOMER_A, runId);
    const line = detail!.lines.find((l) => l.id === lineId)!;
    expect(line.extraDeductionsPreviewTotal).toBe(60000);
    expect(line.personalAllowancePreview).toBe(120000);
    expect(line.deductionWarnings.length).toBe(1);
  });
});

describe("getRunWithLines — เฟส 9b กลุ่ม BF follow-up (2026-08-12) — severanceEligibleForSeparateCalc", () => {
  let tables: Tables;
  let runId: string;
  let empId: string;
  let lineId: string;

  beforeEach(async () => {
    tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, 1);
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    runId = (res as { id: string }).id;
    lineId = tables.payroll_run_lines[0].id as string;
    empId = tables.payroll_run_lines[0].payroll_employee_id as string;
  });

  it("★★★ ยืนยันแล้ว (rd.go.th/61081.html) — อายุงาน <5 ปี → severanceEligibleForSeparateCalc=false ไม่ว่ามี severance_amount หรือไม่", async () => {
    tables.payroll_employees.find((r) => r.id === empId)!.start_date = "2023-01-01"; // เข้างาน 2023 → ถึง pay_date 2026-08-10 = 3 ปีเศษ (<5 ปี)
    const { db } = makeInMemoryDb(tables);
    const detail = await getRunWithLines(db, TENANT, CUSTOMER_A, runId);
    const line = detail!.lines.find((l) => l.id === lineId)!;
    expect(line.severanceEligibleForSeparateCalc).toBe(false);
  });

  it("★★★ อายุงาน ≥5 ปีพอดี → severanceEligibleForSeparateCalc=true", async () => {
    tables.payroll_employees.find((r) => r.id === empId)!.start_date = "2021-08-10"; // เข้างาน 2021-08-10 → ถึง pay_date 2026-08-10 = 5 ปีพอดี
    const { db } = makeInMemoryDb(tables);
    const detail = await getRunWithLines(db, TENANT, CUSTOMER_A, runId);
    const line = detail!.lines.find((l) => l.id === lineId)!;
    expect(line.severanceEligibleForSeparateCalc).toBe(true);
  });
});

describe("getRunWithLines/listRuns/getRunScope", () => {
  let tables: Tables;
  beforeEach(() => {
    tables = baseTables();
  });

  it("getRunWithLines คืน null ถ้าไม่พบ/ลูกค้าไม่ตรง", async () => {
    const { db } = makeInMemoryDb(tables);
    const res = await getRunWithLines(db, TENANT, CUSTOMER_A, "not-exist");
    expect(res).toBeNull();
  });

  it("listRuns เรียงปี/เดือนล่าสุดก่อน", async () => {
    const { db } = makeInMemoryDb(tables);
    await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 1, payDate: "2026-01-05" });
    await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-05" });
    const runs = await listRuns(db, TENANT, CUSTOMER_A);
    expect(runs).toHaveLength(2);
    expect(runs[0].payPeriodMonth).toBe(8);
  });

  it("getRunScope คืน null ถ้าถูกลบไปแล้ว", async () => {
    const { db } = makeInMemoryDb(tables);
    const created = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    const id = (created as { id: string }).id;
    await softDeleteRun(db, TENANT, id);
    const scope = await getRunScope(db, TENANT, id);
    expect(scope).toBeNull();
  });

  // ★★★ เฟส 9b กลุ่ม BB (T131) — badge "prorate อัตโนมัติ" คำนวณสด ๆ ตอนแสดงผล
  it("★ BB: getRunWithLines คืน isProrated=true + daysWorked/daysInMonth ถูกต้องสำหรับพนักงานเข้าใหม่กลางเดือน", async () => {
    const { db } = makeInMemoryDb(tables);
    const ids = seedEmployees(tables, 1);
    tables.payroll_employees.find((r) => r.id === ids[0])!.start_date = "2026-08-16";
    const created = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-31" });
    const runId = (created as { id: string }).id;
    const detail = await getRunWithLines(db, TENANT, CUSTOMER_A, runId);
    expect(detail?.lines[0].isProrated).toBe(true);
    expect(detail?.lines[0].proratedDaysWorked).toBe(16);
    expect(detail?.lines[0].proratedDaysInMonth).toBe(31);
  });

  it("★ BB: พนักงานทำงานเต็มเดือน → isProrated=false", async () => {
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, 1);
    const created = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    const runId = (created as { id: string }).id;
    const detail = await getRunWithLines(db, TENANT, CUSTOMER_A, runId);
    expect(detail?.lines[0].isProrated).toBe(false);
  });
});

describe("buildPayrollJournalEntry (T115, 0.8) — pure", () => {
  function line(p: Partial<PayrollRunLineAmounts>): PayrollRunLineAmounts {
    return {
      grossSalary: 0,
      otherAdditions: 0,
      bonusAmount: 0,
      otherDeductions: 0,
      pitWithheld: 0,
      ssoEmployee: 0,
      ssoEmployer: 0,
      severanceAmount: 0,
      severancePitWithheld: 0,
      netPay: 0,
      ...p,
    };
  }

  it("★★★ Dr รวม = Cr รวมเสมอ (5 คน ยอดต่างกัน รวม other_deductions>0 บางคน)", () => {
    const lines: PayrollRunLineAmounts[] = [
      line({ grossSalary: 20000, pitWithheld: 0, ssoEmployee: 750, ssoEmployer: 750, netPay: 19250 }),
      line({ grossSalary: 30000, otherAdditions: 2000, pitWithheld: 500, ssoEmployee: 750, ssoEmployer: 750, otherDeductions: 300, netPay: 30450 }),
      line({ grossSalary: 15000, pitWithheld: 0, ssoEmployee: 750, ssoEmployer: 750, netPay: 14250 }),
      line({ grossSalary: 50000, pitWithheld: 1200, ssoEmployee: 750, ssoEmployer: 750, netPay: 48050 }),
      line({ grossSalary: 25000, otherDeductions: 100, pitWithheld: 50, ssoEmployee: 750, ssoEmployer: 750, netPay: 24100 }),
    ];
    const res = buildPayrollJournalEntry(lines, DEFAULT_SETTINGS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(isBalanced(toNumericLines(res.lines))).toBe(true);
      expect(res.lines.length).toBeLessThanOrEqual(6);
    }
  });

  it("★★★ จำนวนบรรทัด JE คงที่ไม่ว่าจะมีพนักงานกี่คน (5 vs 150 ต้องได้จำนวนบรรทัดเท่ากัน)", () => {
    const make = (n: number): PayrollRunLineAmounts[] =>
      Array.from({ length: n }, () => line({ grossSalary: 20000, pitWithheld: 100, ssoEmployee: 750, ssoEmployer: 750, otherDeductions: 50, netPay: 19100 }));
    const res5 = buildPayrollJournalEntry(make(5), DEFAULT_SETTINGS);
    const res150 = buildPayrollJournalEntry(make(150), DEFAULT_SETTINGS);
    expect(res5.ok).toBe(true);
    expect(res150.ok).toBe(true);
    if (res5.ok && res150.ok) {
      expect(res5.lines.length).toBe(res150.lines.length);
      expect(res150.lines.length).toBeLessThanOrEqual(6);
      expect(isBalanced(toNumericLines(res150.lines))).toBe(true);
    }
  });

  it("other_deductions=0 ทุกคน → ข้ามบรรทัดนั้นไปเลย (ไม่มีบรรทัด other_deductions)", () => {
    const lines = [line({ grossSalary: 20000, pitWithheld: 100, ssoEmployee: 750, ssoEmployer: 750, netPay: 19150 })];
    const res = buildPayrollJournalEntry(lines, DEFAULT_SETTINGS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.lines.some((l) => l.accountCode === DEFAULT_SETTINGS.otherDeductionsAccountCode)).toBe(false);
      expect(isBalanced(toNumericLines(res.lines))).toBe(true);
    }
  });

  it("other_deductions>0 แต่ settings ไม่มีรหัสบัญชี → ปฏิเสธสร้าง JE พร้อมข้อความชัดเจน", () => {
    const lines = [line({ grossSalary: 20000, otherDeductions: 100, pitWithheld: 0, ssoEmployee: 750, ssoEmployer: 750, netPay: 19150 })];
    const settingsNoOtherDed: PayrollSettings = { ...DEFAULT_SETTINGS, otherDeductionsAccountCode: null };
    const res = buildPayrollJournalEntry(lines, settingsNoOtherDed);
    expect(res.ok).toBe(false);
  });

  it("ไม่มี net_pay_account_code → ปฏิเสธเสมอ (0.11 บังคับกรอกก่อนสร้าง JE ได้จริง)", () => {
    const lines = [line({ grossSalary: 20000, netPay: 19250, ssoEmployee: 750, ssoEmployer: 750 })];
    const settingsNoNetPay: PayrollSettings = { ...DEFAULT_SETTINGS, netPayAccountCode: null };
    const res = buildPayrollJournalEntry(lines, settingsNoNetPay);
    expect(res.ok).toBe(false);
  });

  it("sso_employer=0 ทุกคน → ข้ามบรรทัด Dr sso_employer_expense", () => {
    const lines = [line({ grossSalary: 20000, netPay: 20000 })];
    const res = buildPayrollJournalEntry(lines, DEFAULT_SETTINGS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.lines.some((l) => l.accountCode === DEFAULT_SETTINGS.ssoEmployerExpenseAccountCode)).toBe(false);
      expect(isBalanced(toNumericLines(res.lines))).toBe(true);
    }
  });

  // ★★ แก้บั๊ก QC เฟส 9 (ปัญหาที่ 1ก, defense-in-depth): ปกติ recalcRunLines กันไว้แล้วไม่ให้ net_pay ต่อ
  //   พนักงานติดลบหลุดมาถึงชั้นนี้ — แต่ทดสอบ pure function นี้ตรง ๆ ด้วย netPayTotal ติดลบ (จำลองข้อมูลเก่า/
  //   หลุด validation) ต้องยังคง Dr=Cr เสมอ ไม่ใช่ตัดบรรทัดทิ้งหรือใส่ credit ติดลบ
  it("★★ netPayTotal ติดลบ (สุดวิสัย) → กลับขั้วเป็น Dr net_pay แทน Cr ติดลบ ยังคง Dr=Cr เสมอ", () => {
    const lines = [
      line({ grossSalary: 20000, ssoEmployee: 875, ssoEmployer: 875, otherDeductions: 25000, netPay: -5875 }),
    ];
    const res = buildPayrollJournalEntry(lines, DEFAULT_SETTINGS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const netPayLine = res.lines.find((l) => l.accountCode === DEFAULT_SETTINGS.netPayAccountCode);
      expect(netPayLine).toBeTruthy();
      // ★ ต้องเป็น Dr (ไม่ใช่ Cr ติดลบ) ด้วยยอด abs(netPayTotal)
      expect(Number(netPayLine?.credit ?? 0)).toBe(0);
      expect(Number(netPayLine?.debit ?? 0)).toBe(5875);
      expect(isBalanced(toNumericLines(res.lines))).toBe(true);
    }
  });

  // ★ 0.5/0.8 verify แล้ว — bonus_amount ต้องรวมเข้า Dr salary_expense เสมอตามสเปคเดิม (docs 0.8):
  //   Dr salary_expense = Σ(gross_salary + other_additions + bonus_amount) — ยืนยันว่า logic เดิมของ
  //   buildPayrollJournalEntry รองรับ bonus_amount ใน sum นี้อยู่แล้วตั้งแต่แรก ไม่ต้องแก้เพิ่ม
  it("★ 0.5 bonus_amount รวมเข้า Dr salary_expense (Σ gross+additions+bonus) — Dr=Cr เสมอ", () => {
    const lines = [
      line({ grossSalary: 60000, bonusAmount: 90000, pitWithheld: 16541.67, ssoEmployee: 875, ssoEmployer: 875, netPay: 132583.33 }),
    ];
    const res = buildPayrollJournalEntry(lines, DEFAULT_SETTINGS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const salaryLine = res.lines.find((l) => l.accountCode === DEFAULT_SETTINGS.salaryExpenseAccountCode);
      expect(Number(salaryLine?.debit ?? 0)).toBe(150000); // 60000(gross) + 90000(bonus)
      expect(isBalanced(toNumericLines(res.lines))).toBe(true);
    }
  });

  it("netPayTotal = 0 พอดี (net pay ของทุกคนรวมกันเป็น 0) → ข้ามบรรทัด net_pay ไปเลย ยังคง Dr=Cr", () => {
    const lines = [line({ grossSalary: 1000, otherDeductions: 1000, netPay: 0 })];
    const res = buildPayrollJournalEntry(lines, DEFAULT_SETTINGS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.lines.some((l) => l.accountCode === DEFAULT_SETTINGS.netPayAccountCode)).toBe(false);
      expect(isBalanced(toNumericLines(res.lines))).toBe(true);
    }
  });

  // ★★★ เฟส 9b กลุ่ม BF (T164) — ค่าตอบแทนเลิกจ้าง/ชดเชย ใน JE
  describe("★★★ BF: severance_amount/severance_pit_withheld", () => {
    it("severance_amount > 0 + ตั้งรหัสบัญชีค่าชดเชยแล้ว → Dr severance_expense เข้า JE, Dr=Cr เสมอ", () => {
      const lines = [
        line({
          grossSalary: 20000,
          pitWithheld: 0,
          ssoEmployee: 875,
          ssoEmployer: 875,
          severanceAmount: 500000,
          severancePitWithheld: 0,
          netPay: 20000 - 875 + 500000,
        }),
      ];
      const res = buildPayrollJournalEntry(lines, DEFAULT_SETTINGS);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const severanceLine = res.lines.find((l) => l.accountCode === DEFAULT_SETTINGS.severanceExpenseAccountCode);
        expect(severanceLine).toBeTruthy();
        expect(Number(severanceLine?.debit ?? 0)).toBe(500000);
        expect(isBalanced(toNumericLines(res.lines))).toBe(true);
      }
    });

    it("severance_amount > 0 แต่ไม่ได้ตั้งรหัสบัญชีค่าชดเชย → ปฏิเสธสร้าง JE พร้อมข้อความชัดเจน (mirror other_deductions)", () => {
      const lines = [line({ grossSalary: 20000, severanceAmount: 500000, netPay: 520000 })];
      const settingsNoSeverance: PayrollSettings = { ...DEFAULT_SETTINGS, severanceExpenseAccountCode: null };
      const res = buildPayrollJournalEntry(lines, settingsNoSeverance);
      expect(res.ok).toBe(false);
    });

    it("severance_amount = 0 ทุกคน → ข้ามบรรทัด severance_expense ไปเลย (ไม่มีบรรทัดค่าชดเชย)", () => {
      const lines = [line({ grossSalary: 20000, pitWithheld: 100, ssoEmployee: 750, ssoEmployer: 750, netPay: 19150 })];
      const res = buildPayrollJournalEntry(lines, DEFAULT_SETTINGS);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.lines.some((l) => l.accountCode === DEFAULT_SETTINGS.severanceExpenseAccountCode)).toBe(false);
        expect(isBalanced(toNumericLines(res.lines))).toBe(true);
      }
    });

    it("severance_pit_withheld > 0 (จำลอง flag=true) → รวมเข้า Cr pit_payable เดียวกับ pit ปกติ, Dr=Cr เสมอ", () => {
      const lines = [
        line({
          grossSalary: 30000,
          pitWithheld: 200,
          ssoEmployee: 750,
          ssoEmployer: 750,
          severanceAmount: 2000000,
          severancePitWithheld: 68000,
          netPay: 30000 - 200 - 750 + 2000000 - 68000,
        }),
      ];
      const res = buildPayrollJournalEntry(lines, DEFAULT_SETTINGS);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const pitLine = res.lines.find((l) => l.accountCode === DEFAULT_SETTINGS.pitPayableAccountCode);
        expect(Number(pitLine?.credit ?? 0)).toBe(200 + 68000);
        expect(isBalanced(toNumericLines(res.lines))).toBe(true);
      }
    });

    it("หลายพนักงานผสมกัน (บางคนมี severance บางคนไม่มี) → รวมยอด Σ severance_amount ถูกต้อง, Dr=Cr เสมอ, จำนวนบรรทัด JE ยังคงที่ (≤7)", () => {
      const lines = [
        line({ grossSalary: 20000, pitWithheld: 0, ssoEmployee: 875, ssoEmployer: 875, netPay: 19125 }),
        line({
          grossSalary: 20000,
          pitWithheld: 0,
          ssoEmployee: 875,
          ssoEmployer: 875,
          severanceAmount: 300000,
          netPay: 20000 - 875 + 300000,
        }),
      ];
      const res = buildPayrollJournalEntry(lines, DEFAULT_SETTINGS);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const severanceLine = res.lines.find((l) => l.accountCode === DEFAULT_SETTINGS.severanceExpenseAccountCode);
        expect(Number(severanceLine?.debit ?? 0)).toBe(300000);
        expect(res.lines.length).toBeLessThanOrEqual(7);
        expect(isBalanced(toNumericLines(res.lines))).toBe(true);
      }
    });
  });
});

describe("generateRunJournalEntry (T115, 0.7/0.9)", () => {
  let tables: Tables;
  let runId: string;

  beforeEach(async () => {
    tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, 3);
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    runId = (res as { id: string }).id;
    await recalcRunLines(db, TENANT, CUSTOMER_A, runId);
  });

  it("สร้าง JE สำเร็จ — เป็น draft เสมอ (0.7), status รอบเปลี่ยนเป็น finalized", async () => {
    const { db } = makeInMemoryDb(tables);
    const res = await generateRunJournalEntry(db, TENANT, CUSTOMER_A, runId, chartByCode);
    expect(res.ok).toBe(true);
    const entry = tables.manual_journal_entries[0];
    expect(entry.status).toBe("draft");
    const run = tables.payroll_runs.find((r) => r.id === runId)!;
    expect(run.status).toBe("finalized");
    expect(run.manual_entry_id).toBeTruthy();
  });

  it("JE ที่สร้าง Dr=Cr เสมอ", async () => {
    const { db } = makeInMemoryDb(tables);
    await generateRunJournalEntry(db, TENANT, CUSTOMER_A, runId, chartByCode);
    const lines = tables.manual_journal_entry_lines.filter((l) => true);
    const totalDebit = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.01);
  });

  it("★★★ 0.9 เรียกซ้ำ (จำลอง 2 request พร้อมกัน) → สร้างได้แค่ครั้งเดียว", async () => {
    const { db } = makeInMemoryDb(tables);
    const [r1, r2] = await Promise.all([
      generateRunJournalEntry(db, TENANT, CUSTOMER_A, runId, chartByCode),
      generateRunJournalEntry(db, TENANT, CUSTOMER_A, runId, chartByCode),
    ]);
    const successes = [r1, r2].filter((r) => r.ok);
    expect(successes).toHaveLength(1);
    expect(tables.manual_journal_entries).toHaveLength(1);
  });

  it("กดสร้างซ้ำหลังสร้างสำเร็จแล้ว → ปฏิเสธ พร้อม existingManualEntryId", async () => {
    const { db } = makeInMemoryDb(tables);
    const first = await generateRunJournalEntry(db, TENANT, CUSTOMER_A, runId, chartByCode);
    expect(first.ok).toBe(true);
    const second = await generateRunJournalEntry(db, TENANT, CUSTOMER_A, runId, chartByCode);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.existingManualEntryId).toBeTruthy();
  });

  it("รอบที่ finalized แล้ว → recalcRunLines ถูกปฏิเสธ (ล็อกหลังสร้าง JE)", async () => {
    const { db } = makeInMemoryDb(tables);
    await generateRunJournalEntry(db, TENANT, CUSTOMER_A, runId, chartByCode);
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId);
    expect(res.ok).toBe(false);
  });

  it("ไม่มี settings ของลูกค้า → ปฏิเสธ + revert claim กลับเป็น draft (retry ได้)", async () => {
    tables.payroll_settings = [];
    const { db } = makeInMemoryDb(tables);
    const res = await generateRunJournalEntry(db, TENANT, CUSTOMER_A, runId, chartByCode);
    expect(res.ok).toBe(false);
    const run = tables.payroll_runs.find((r) => r.id === runId)!;
    expect(run.status).toBe("draft");
    expect(run.manual_entry_id ?? null).toBeNull();
  });
});

// ★★★ เฟส 9b กลุ่ม BC (0.5) — markPitFiled/unmarkPitFiled/markSsoFiled/unmarkSsoFiled ย้ายไปทำงานบน
//   payroll_monthly_filings แล้ว (lib/accounting/payroll-monthly-filing.ts) — เทสต์ตัวฟังก์ชันเหล่านี้เต็ม ๆ
//   อยู่ที่ tests/accounting/payroll-monthly-filing.test.ts — ที่นี่ทดสอบเฉพาะว่า createDraftRun/
//   getRunScope/getRunWithLines/listRuns ของไฟล์นี้ผูก/แสดง filing_period_id ถูกต้อง (ส่วนที่ยังอยู่ในไฟล์นี้)
describe("เฟส 9b กลุ่ม BC — createDraftRun ผูก filing_period_id + pay_frequency guard (T138)", () => {
  let tables: Tables;
  beforeEach(() => {
    tables = baseTables();
  });

  it("ลูกค้า pay_frequency='monthly' (ค่า default, ไม่มีแถว payroll_settings เลย) → รอบใหม่ได้ filing_period_id เสมอ", async () => {
    const { db } = makeInMemoryDb(tables);
    tables.payroll_settings = [];
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    expect(res.ok).toBe(true);
    const run = tables.payroll_runs[0];
    expect(run.filing_period_id).toBeTruthy();
    expect(tables.payroll_monthly_filings).toHaveLength(1);
    const filing = tables.payroll_monthly_filings[0];
    expect(filing.period_year).toBe(2569);
    expect(filing.period_month).toBe(8);
  });

  it("★ regression: ลูกค้า pay_frequency='monthly' สร้างรอบซ้ำเดือน/ปีเดียวกัน → ปฏิเสธเหมือนก่อนเฟส 9b เป๊ะ", async () => {
    const { db } = makeInMemoryDb(tables);
    const first = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    expect(first.ok).toBe(true);
    const second = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-20" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toContain("มีรอบเงินเดือนของเดือน/ปีนี้อยู่แล้ว");
    // ★ ไม่มีการสร้างหน่วยยื่นซ้ำ (idempotent)
    expect(tables.payroll_monthly_filings).toHaveLength(1);
  });

  it("★★★ ลูกค้า pay_frequency='non_monthly' → สร้างหลายรอบเดือน/ปีเดียวกันได้ ทุกรอบผูก filing_period_id เดียวกัน", async () => {
    tables.payroll_settings = [
      {
        id: "settings-nm",
        tenant_id: TENANT,
        customer_id: CUSTOMER_A,
        salary_expense_account_code: "5310",
        sso_employer_expense_account_code: "5311",
        sso_payable_account_code: "2050",
        pit_payable_account_code: "2910",
        other_deductions_account_code: null,
        net_pay_account_code: null,
        net_pay_is_paid_immediately: false,
        pay_frequency: "non_monthly",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    const { db } = makeInMemoryDb(tables);
    const r1 = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-07" });
    const r2 = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-14" });
    const r3 = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-21" });
    const r4 = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-28" });
    expect([r1, r2, r3, r4].every((r) => r.ok)).toBe(true);
    expect(tables.payroll_runs).toHaveLength(4);
    // ★ หน่วยยื่นเดือนนี้มีแถวเดียว (idempotent get-or-create) ทุกรอบชี้แถวเดียวกัน
    expect(tables.payroll_monthly_filings).toHaveLength(1);
    const filingId = tables.payroll_monthly_filings[0].id;
    expect(tables.payroll_runs.every((r) => r.filing_period_id === filingId)).toBe(true);
  });

  it("getRunScope คืน filingPeriodId ของรอบที่สร้างแล้ว", async () => {
    const { db } = makeInMemoryDb(tables);
    const created = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    const id = (created as { id: string }).id;
    const scope = await getRunScope(db, TENANT, id);
    expect(scope?.filingPeriodId).toBeTruthy();
  });

  // ★★★ แก้บั๊ก QC (race condition จริง, migration 0097) — พิสูจน์ด้วยเทสต์ concurrent จริง (Promise.all) ว่า
  //   partial unique index `uq_payroll_runs_period_monthly` (บน pay_frequency_snapshot='monthly') คุม
  //   atomicity ได้จริงที่ระดับ DB ไม่ใช่แค่ precheck ที่ชั้นแอปที่ไม่ atomic (เดิม 0096 เอา unique constraint
  //   ออกจาก DB ไปเฉย ๆ ทำให้ 2 request พร้อมกันสร้างสำเร็จทั้งคู่ได้จริง — mirror pattern เดียวกับเทสต์
  //   0.9 ของ generateRunJournalEntry ด้านบนที่พิสูจน์ atomicity ด้วย Promise.all เหมือนกัน)
  describe("★★★ แก้บั๊ก QC — race condition จริง เมื่อ 2 request สร้างรอบเดือน/ปีเดียวกันพร้อมกัน (migration 0097)", () => {
    function withMonthlyUniqueIndex(t: Tables) {
      const uniqueIndexes = [
        {
          table: "payroll_runs",
          columns: ["tenant_id", "customer_id", "pay_period_year", "pay_period_month"],
          // ★ mirror partial unique index จริงที่ DB — unique เฉพาะแถว deleted_at is null และ
          //   pay_frequency_snapshot='monthly' เท่านั้น (ตรงกับ uq_payroll_runs_period_monthly ใน 0097)
          where: (r: Row) => !r.deleted_at && r.pay_frequency_snapshot === "monthly",
        },
      ];
      return makeInMemoryDb(t, { uniqueIndexes });
    }

    it("ลูกค้า pay_frequency='monthly' — 2 request สร้างรอบเดือน/ปีเดียวกันพร้อมกัน → สำเร็จแค่ 1 ใน 2 เท่านั้น (ไม่ใช่ทั้งคู่)", async () => {
      const { db } = withMonthlyUniqueIndex(tables);
      const [r1, r2] = await Promise.all([
        createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" }),
        createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-20" }),
      ]);
      const successes = [r1, r2].filter((r) => r.ok);
      const failures = [r1, r2].filter((r) => !r.ok);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      if (!failures[0].ok) expect(failures[0].message).toContain("มีรอบเงินเดือนของเดือน/ปีนี้อยู่แล้ว");
      // ★ มีรอบเดียวจริงในฐานข้อมูล ไม่ใช่ 2 รอบ (นี่คือใจความของบั๊ก — เดิมสร้างสำเร็จทั้ง 2 ครั้ง)
      expect(tables.payroll_runs.filter((r) => !r.deleted_at)).toHaveLength(1);
    });

    it("ลูกค้า pay_frequency='non_monthly' — 2 request สร้างรอบเดือน/ปีเดียวกันพร้อมกัน → สำเร็จทั้งคู่ (ไม่ถูกกระทบจาก unique index ใหม่)", async () => {
      tables.payroll_settings = [
        {
          id: "settings-nm",
          tenant_id: TENANT,
          customer_id: CUSTOMER_A,
          salary_expense_account_code: "5310",
          sso_employer_expense_account_code: "5311",
          sso_payable_account_code: "2050",
          pit_payable_account_code: "2910",
          other_deductions_account_code: null,
          net_pay_account_code: null,
          net_pay_is_paid_immediately: false,
          pay_frequency: "non_monthly",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ];
      const { db } = withMonthlyUniqueIndex(tables);
      const [r1, r2] = await Promise.all([
        createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-07" }),
        createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-14" }),
      ]);
      expect([r1, r2].every((r) => r.ok)).toBe(true);
      expect(tables.payroll_runs.filter((r) => !r.deleted_at)).toHaveLength(2);
    });
  });
});
