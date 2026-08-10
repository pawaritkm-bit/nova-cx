import { describe, it, expect, beforeEach } from "vitest";
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
  markPitFiled,
  unmarkPitFiled,
  markSsoFiled,
  type PayrollRunLineAmounts,
} from "@/lib/accounting/payroll";
import type { PayrollSettings } from "@/lib/accounting/payroll-settings";

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

  it("★★ 0.5 ปฏิเสธ bonus_amount > 0 ทั้งชุด (ปิดสวิตช์ชั่วคราว) — ไม่บันทึกบรรทัดใดเลย", async () => {
    const { db } = makeInMemoryDb(tables);
    const lineId = tables.payroll_run_lines[0].id as string;
    const before = JSON.stringify(tables.payroll_run_lines);
    const res = await recalcRunLines(db, TENANT, CUSTOMER_A, runId, [
      { id: lineId, grossSalary: 20000, otherAdditions: 0, bonusAmount: 5000, otherDeductions: 0 },
    ]);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(tables.payroll_run_lines)).toBe(before);
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

describe("markPitFiled/unmarkPitFiled/markSsoFiled (T116, 0.3)", () => {
  let tables: Tables;
  let runId: string;

  beforeEach(async () => {
    tables = baseTables();
    const { db } = makeInMemoryDb(tables);
    seedEmployees(tables, 2);
    const res = await createDraftRun(db, TENANT, CUSTOMER_A, { payPeriodYear: 2569, payPeriodMonth: 8, payDate: "2026-08-10" });
    runId = (res as { id: string }).id;
  });

  it("รอบยัง draft (ไม่มี JE) → mark filed ถูกปฏิเสธ", async () => {
    const { db } = makeInMemoryDb(tables);
    const res = await markPitFiled(db, TENANT, runId, "acc-1");
    expect(res.ok).toBe(false);
  });

  it("รอบ finalized → mark สำเร็จ ตั้ง filed_at/filed_by ถูกต้อง", async () => {
    const runRow = tables.payroll_runs.find((r) => r.id === runId)!;
    runRow.status = "finalized";
    const { db } = makeInMemoryDb(tables);
    const res = await markPitFiled(db, TENANT, runId, "acc-1");
    expect(res.ok).toBe(true);
    const row = tables.payroll_runs.find((r) => r.id === runId)!;
    expect(row.pit_filing_status).toBe("filed");
    expect(row.pit_filed_by).toBe("acc-1");
    expect(row.pit_filed_at).toBeTruthy();
  });

  it("unmark รีเซ็ตกลับ not_filed ได้", async () => {
    const runRow = tables.payroll_runs.find((r) => r.id === runId)!;
    runRow.status = "finalized";
    const { db } = makeInMemoryDb(tables);
    await markPitFiled(db, TENANT, runId, "acc-1");
    const res = await unmarkPitFiled(db, TENANT, runId);
    expect(res.ok).toBe(true);
    const row = tables.payroll_runs.find((r) => r.id === runId)!;
    expect(row.pit_filing_status).toBe("not_filed");
    expect(row.pit_filed_by ?? null).toBeNull();
  });

  it("markSsoFiled แยกอิสระจาก pit (mark pit ไม่กระทบสถานะ sso)", async () => {
    const runRow = tables.payroll_runs.find((r) => r.id === runId)!;
    runRow.status = "finalized";
    const { db } = makeInMemoryDb(tables);
    await markPitFiled(db, TENANT, runId, "acc-1");
    const res = await markSsoFiled(db, TENANT, runId, "acc-1");
    expect(res.ok).toBe(true);
    const row = tables.payroll_runs.find((r) => r.id === runId)!;
    expect(row.pit_filing_status).toBe("filed");
    expect(row.sso_filing_status).toBe("filed");
  });
});
