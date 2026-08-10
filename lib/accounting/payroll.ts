/**
 * รอบเงินเดือน (Payroll Run) — orchestrator: สร้างรอบ, คำนวณภาษี/ประกันสังคม, สร้างรายการบัญชี (JE),
 *   บันทึกสถานะยื่น ภ.ง.ด.1/สปส.1-10
 *
 * บริบท: เฟส 9 ส่วน AD (docs/06-accounting-features-roadmap.md, หมวด 0.3/0.7/0.8/0.9/0.13/0.14)
 *
 * ★★★ 0.8 JE ต่อรอบเป็น "1 ใบรวมยอด" (4-6 บรรทัด) ไม่ใช่ 1 บรรทัดต่อพนักงาน แม้มีพนักงาน 100+ คน —
 *   `buildPayrollJournalEntry` รวมยอด (SUM) ต่อรหัสบัญชีก่อนสร้างบรรทัด JE เสมอ
 * ★★★ 0.9 กันกดปุ่ม "สร้าง JE" ซ้ำสอง — atomic claim ก่อนเรียก `upsertManualEntry` เสมอ (ไม่ใช่หลัง)
 *   ★ deviation ที่ตั้งใจจากคำบรรยายตรงตัวในเอกสารแผน: เอกสารเขียนว่า claim ผ่าน
 *   `UPDATE payroll_runs SET manual_entry_id=... WHERE manual_entry_id IS NULL` แต่ `manual_entry_id`
 *   เป็น FK ไปยัง manual_journal_entries — ไม่มีทางเขียนค่า placeholder ที่ไม่มีจริงลงคอลัมน์นี้ได้ (ละเมิด
 *   FK) ก่อนที่จะรู้ id จริงของ JE (ซึ่งต้องรอ upsertManualEntry สร้างเสร็จก่อน) → ใช้คอลัมน์ `status`
 *   (คอลัมน์เดียว มีอยู่แล้วในตาราง) เป็นตัวกั้น atomic แทนโดยเจตนาเดียวกันทุกประการ: single
 *   `UPDATE ... WHERE status='draft' AND manual_entry_id IS NULL ... RETURNING id` ก่อนเรียก
 *   `upsertManualEntry` เสมอ — claim ไม่ติด (ไม่ได้แถวกลับมา) = มีคนกดสร้างไปแล้ว → ปฏิเสธ ไม่สร้าง JE ที่สอง
 *   ถ้า `upsertManualEntry` ล้มเหลวหลัง claim สำเร็จ → revert สถานะกลับ 'draft' (compensating rollback,
 *   mirror `fixed-assets.ts::generateOne`)
 * ★ 0.7 Never-auto-confirm — JE ที่สร้างจากรอบเงินเดือนเป็น `draft` เสมอผ่าน `upsertManualEntry` เท่านั้น
 * ★★ 0.5 โบนัส [ปิดสวิตช์ชั่วคราว] — `bonus_amount > 0` ถูกปฏิเสธที่ชั้น validate ของไฟล์นี้ (ดูคอมเมนต์เต็ม
 *   ใน `payroll-tax.ts` ด้านบนไฟล์) จนกว่าจะ verify สูตรภาษีโบนัสกับตัวอย่างอ้างอิงที่เชื่อถือได้จริง (T112)
 * ★ 0.2 ทุกจุดที่ query พนักงาน ใช้ `payroll-employees.ts` เท่านั้น — ไม่ import จาก accountant-scope.ts/
 *   employees ที่เป็นพนักงานภายใน Finovas ปนกันในไฟล์นี้เด็ดขาด
 * ★ ทุก query/write กรอง tenant_id + customer_id เสมอ — IDOR-safe (0.15) ทำที่ actions.ts ชั้นบนด้วย
 *   requireAccountingAccess + assertCustomerInScope + derive scope จาก resource id ที่กำลังเขียนจริง
 * ★ chunkIds ทุกจุดที่ query `.in()` รายชื่อพนักงานที่อาจมี 100+ คน (0.1, บทเรียน commit 7ab9f91)
 * ★ PDPA: ไม่ log ชื่อพนักงาน/เลขบัตร/เงินเดือน/ชื่อลูกค้าที่ไหนในไฟล์นี้
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { round2 } from "@/lib/accounting/queries";
import { isValidCalendarDate } from "@/lib/accounting/bank-reconciliation";
import { chunkIds } from "@/lib/accounting/id-chunk";
import {
  upsertManualEntry,
  type ManualEntryLineInput,
  type ManualEntryInput,
} from "@/lib/accounting/manual-journal";
import { getEffectivePitBrackets, getEffectiveSsoConfig } from "@/lib/accounting/payroll-config";
import {
  calcMonthlyPitForRegularIncome,
  calcSsoContribution,
  remainingPeriodsInYear,
  PERSONAL_ALLOWANCE_STANDARD,
} from "@/lib/accounting/payroll-tax";
import { listEmployees } from "@/lib/accounting/payroll-employees";
import { getSettings, type PayrollSettings } from "@/lib/accounting/payroll-settings";

type DB = SupabaseClient;

export type PayrollRunStatus = "draft" | "finalized";
export type PayrollFilingStatus = "not_filed" | "filed";

/** ★★ [ปิดสวิตช์ชั่วคราว 0.5] — bonus_amount > 0 ยังไม่เปิดใช้งาน (ต้อง verify สูตรภาษีโบนัสก่อน, T112) */
export const BONUS_DISABLED_MESSAGE =
  "ฟีเจอร์คำนวณภาษีโบนัส/เงินได้ครั้งเดียว (ตามคำสั่งกรมสรรพากร ทป.4/2528) ยังไม่เปิดใช้งาน (รอ verify สูตรกับตัวอย่างคำนวณอ้างอิงที่เชื่อถือได้จริง) — กรุณากรอก 0 ไปก่อน";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_LIST_LIMIT = 500;
const LINE_LIST_LIMIT = 5000;

function parseMoney(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? round2(n) : null;
}

// ---------------------------------------------------------------------
// ชนิดข้อมูล
// ---------------------------------------------------------------------

export type PayrollRun = {
  id: string;
  tenantId: string;
  customerId: string;
  payPeriodYear: number;
  payPeriodMonth: number;
  payDate: string;
  status: PayrollRunStatus;
  manualEntryId: string | null;
  pitFilingStatus: PayrollFilingStatus;
  pitFiledAt: string | null;
  pitFiledBy: string | null;
  ssoFilingStatus: PayrollFilingStatus;
  ssoFiledAt: string | null;
  ssoFiledBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** สโคป + สถานะของรอบ 1 รอบ (IDOR guard, 0.15) — โหลดครั้งเดียวก่อนแตะ DB ทุกครั้งที่ actions.ts เรียก */
export type PayrollRunScope = {
  customerId: string;
  status: PayrollRunStatus;
  manualEntryId: string | null;
  payDate: string;
  payPeriodYear: number;
  payPeriodMonth: number;
};

/** บรรทัดรอบเงินเดือนต่อพนักงาน 1 คน (แสดงผล — join ชื่อพนักงานจาก payroll_employees) */
export type PayrollRunLine = {
  id: string;
  runId: string;
  payrollEmployeeId: string;
  employeeFullName: string;
  employeeCode: string | null;
  grossSalary: number;
  otherAdditions: number;
  bonusAmount: number;
  otherDeductions: number;
  pitWithheld: number;
  ssoEmployee: number;
  ssoEmployer: number;
  netPay: number;
};

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline */
export type PayrollActionResult = { ok: true; id: string } | { ok: false; message: string };

// ---------------------------------------------------------------------
// createDraftRun (T114)
// ---------------------------------------------------------------------

export type CreateRunInput = {
  payPeriodYear: unknown;
  payPeriodMonth: unknown;
  payDate: unknown;
};

function validateCreateRunInput(
  input: CreateRunInput
): { ok: true; value: { payPeriodYear: number; payPeriodMonth: number; payDate: string } } | { ok: false; message: string } {
  const year = typeof input.payPeriodYear === "number" ? input.payPeriodYear : Number(input.payPeriodYear);
  if (!Number.isFinite(year) || !Number.isInteger(year) || year < 2500 || year > 2700) {
    return { ok: false, message: "ปี (พ.ศ.) ไม่ถูกต้อง" };
  }
  const month = typeof input.payPeriodMonth === "number" ? input.payPeriodMonth : Number(input.payPeriodMonth);
  if (!Number.isFinite(month) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, message: "เดือนไม่ถูกต้อง (1-12)" };
  }
  const payDate = typeof input.payDate === "string" && DATE_RE.test(input.payDate) ? input.payDate : "";
  if (!payDate || !isValidCalendarDate(payDate)) {
    return { ok: false, message: "วันที่จ่ายไม่ถูกต้อง (YYYY-MM-DD)" };
  }
  return { ok: true, value: { payPeriodYear: year, payPeriodMonth: month, payDate } };
}

/**
 * สร้างรอบเงินเดือนใหม่ (draft) + prefill บรรทัดจากพนักงาน active ทั้งหมดของลูกค้ารายนี้ (0.13)
 *   ★ ใช้ listEmployees({activeOnly:true}) ที่กรอง customer_id อยู่แล้ว (ไม่ใช่ .in(ids) จึงไม่ต้อง
 *   chunkIds ตอน select) — แต่ insert บรรทัด prefill แบ่งเป็นก้อนละ ≤150 (มิเรอร์เพดานเดียวกับ chunkIds)
 *   กันคำขอเดียวมี payload ใหญ่ผิดปกติเมื่อลูกค้ามีพนักงาน 100+ คน (0.1)
 */
export async function createDraftRun(
  db: DB,
  tenantId: string,
  customerId: string,
  input: CreateRunInput
): Promise<PayrollActionResult> {
  const v = validateCreateRunInput(input);
  if (!v.ok) return v;

  // ★ ตั้งค่าเริ่มต้นทุกช่องตรง ๆ (ไม่พึ่ง DB default เฉย ๆ) — mirror pattern เดิมทั้งระบบ (เช่น
  //   manual-journal.ts::upsertManualEntry ตั้ง status:"draft" ตรง ๆ ตอน insert เสมอ)
  const { data, error } = await db
    .from("payroll_runs")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      pay_period_year: v.value.payPeriodYear,
      pay_period_month: v.value.payPeriodMonth,
      pay_date: v.value.payDate,
      status: "draft",
      manual_entry_id: null,
      pit_filing_status: "not_filed",
      pit_filed_at: null,
      pit_filed_by: null,
      sso_filing_status: "not_filed",
      sso_filed_at: null,
      sso_filed_by: null,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    if (error?.code === "23505") {
      return { ok: false, message: "มีรอบเงินเดือนของเดือน/ปีนี้อยู่แล้ว (ลบรอบเดิมก่อนถ้าต้องการสร้างใหม่)" };
    }
    return { ok: false, message: "สร้างรอบเงินเดือนไม่สำเร็จ กรุณาลองใหม่" };
  }
  const runId = (data as { id: string }).id;

  const employees = await listEmployees(db, tenantId, customerId, { activeOnly: true });
  const chunks = chunkIds(employees.map((e) => e.id));
  for (const chunk of chunks) {
    const byId = new Map(employees.map((e) => [e.id, e]));
    // ★ ตั้งค่าเริ่มต้นทุกช่องตัวเลขตรง ๆ (ไม่พึ่ง DB default เฉย ๆ) — payload ชัดเจนในตัวเอง
    //   (mirror pattern fixed-assets.ts::upsertAsset ที่ตั้ง accumulated_depreciation: 0 ตรง ๆ ตอน insert)
    const rows = chunk.map((id) => ({
      tenant_id: tenantId,
      run_id: runId,
      payroll_employee_id: id,
      gross_salary: byId.get(id)?.baseSalary ?? 0,
      other_additions: 0,
      bonus_amount: 0,
      other_deductions: 0,
      pit_withheld: 0,
      sso_employee: 0,
      sso_employer: 0,
      net_pay: 0,
    }));
    if (rows.length > 0) await db.from("payroll_run_lines").insert(rows);
  }

  return { ok: true, id: runId };
}

// ---------------------------------------------------------------------
// data layer — โหลดรอบ/บรรทัด
// ---------------------------------------------------------------------

type RawRunRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  pay_period_year: number;
  pay_period_month: number;
  pay_date: string;
  status: string;
  manual_entry_id: string | null;
  pit_filing_status: string;
  pit_filed_at: string | null;
  pit_filed_by: string | null;
  sso_filing_status: string;
  sso_filed_at: string | null;
  sso_filed_by: string | null;
  created_at: string;
  updated_at: string;
};

const RUN_COLUMNS =
  "id, tenant_id, customer_id, pay_period_year, pay_period_month, pay_date, status, manual_entry_id, pit_filing_status, pit_filed_at, pit_filed_by, sso_filing_status, sso_filed_at, sso_filed_by, created_at, updated_at";

function mapRunRow(r: RawRunRow): PayrollRun {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    payPeriodYear: r.pay_period_year,
    payPeriodMonth: r.pay_period_month,
    payDate: r.pay_date,
    status: (r.status as PayrollRunStatus) ?? "draft",
    manualEntryId: r.manual_entry_id,
    pitFilingStatus: (r.pit_filing_status as PayrollFilingStatus) ?? "not_filed",
    pitFiledAt: r.pit_filed_at,
    pitFiledBy: r.pit_filed_by,
    ssoFilingStatus: (r.sso_filing_status as PayrollFilingStatus) ?? "not_filed",
    ssoFiledAt: r.sso_filed_at,
    ssoFiledBy: r.sso_filed_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** รายการรอบเงินเดือนของลูกค้า 1 ราย เรียงปี/เดือนล่าสุดก่อน */
export async function listRuns(db: DB, tenantId: string, customerId: string): Promise<PayrollRun[]> {
  const { data, error } = await db
    .from("payroll_runs")
    .select(RUN_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("pay_period_year", { ascending: false })
    .order("pay_period_month", { ascending: false })
    .limit(RUN_LIST_LIMIT);
  if (error || !data) return [];
  return (data as unknown as RawRunRow[]).map(mapRunRow);
}

/** โหลดสโคป+สถานะของรอบ 1 รอบ (scope tenant) — ใช้ตรวจสโคปก่อนแก้/ลบ/สร้าง JE ทุกครั้ง (0.15) */
export async function getRunScope(db: DB, tenantId: string, id: string): Promise<PayrollRunScope | null> {
  const { data } = await db
    .from("payroll_runs")
    .select("customer_id, status, manual_entry_id, pay_date, pay_period_year, pay_period_month")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as {
    customer_id: string;
    status: string;
    manual_entry_id: string | null;
    pay_date: string;
    pay_period_year: number;
    pay_period_month: number;
  };
  return {
    customerId: r.customer_id,
    status: (r.status as PayrollRunStatus) ?? "draft",
    manualEntryId: r.manual_entry_id,
    payDate: r.pay_date,
    payPeriodYear: r.pay_period_year,
    payPeriodMonth: r.pay_period_month,
  };
}

type RawLineRow = {
  id: string;
  run_id: string;
  payroll_employee_id: string;
  gross_salary: number | string;
  other_additions: number | string;
  bonus_amount: number | string;
  other_deductions: number | string;
  pit_withheld: number | string;
  sso_employee: number | string;
  sso_employer: number | string;
  net_pay: number | string;
};

const LINE_COLUMNS =
  "id, run_id, payroll_employee_id, gross_salary, other_additions, bonus_amount, other_deductions, pit_withheld, sso_employee, sso_employer, net_pay";

async function fetchRawLines(db: DB, tenantId: string, runId: string): Promise<RawLineRow[]> {
  const { data } = await db
    .from("payroll_run_lines")
    .select(LINE_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("run_id", runId)
    .limit(LINE_LIST_LIMIT);
  return (data ?? []) as unknown as RawLineRow[];
}

/**
 * ชื่อพนักงาน (fullName/employeeCode) ของ payrollEmployeeIds ที่ระบุ — chunkIds กัน `.in()` ยาวเกิน limit
 *   เมื่อลูกค้ามีพนักงาน 100+ คน (0.1, บทเรียน commit 7ab9f91)
 */
async function fetchEmployeeNames(
  db: DB,
  tenantId: string,
  customerId: string,
  ids: string[]
): Promise<Map<string, { fullName: string; employeeCode: string | null }>> {
  const map = new Map<string, { fullName: string; employeeCode: string | null }>();
  const uniqIds = [...new Set(ids)];
  if (uniqIds.length === 0) return map;
  const chunks = await Promise.all(
    chunkIds(uniqIds).map((chunk) =>
      db
        .from("payroll_employees")
        .select("id, full_name, employee_code")
        .eq("tenant_id", tenantId)
        .eq("customer_id", customerId)
        .in("id", chunk)
    )
  );
  for (const { data } of chunks) {
    for (const r of (data ?? []) as { id: string; full_name: string; employee_code: string | null }[]) {
      map.set(r.id, { fullName: r.full_name, employeeCode: r.employee_code });
    }
  }
  return map;
}

function mapLineAmounts(r: RawLineRow): Omit<PayrollRunLine, "employeeFullName" | "employeeCode"> {
  return {
    id: r.id,
    runId: r.run_id,
    payrollEmployeeId: r.payroll_employee_id,
    grossSalary: round2(Number(r.gross_salary)),
    otherAdditions: round2(Number(r.other_additions)),
    bonusAmount: round2(Number(r.bonus_amount)),
    otherDeductions: round2(Number(r.other_deductions)),
    pitWithheld: round2(Number(r.pit_withheld)),
    ssoEmployee: round2(Number(r.sso_employee)),
    ssoEmployer: round2(Number(r.sso_employer)),
    netPay: round2(Number(r.net_pay)),
  };
}

/** โหลดรอบ + บรรทัดทั้งหมด (พร้อมชื่อพนักงาน) — คืน null ถ้าไม่พบรอบ/ลูกค้าไม่ตรง */
export async function getRunWithLines(
  db: DB,
  tenantId: string,
  customerId: string,
  runId: string
): Promise<{ run: PayrollRun; lines: PayrollRunLine[] } | null> {
  const { data } = await db
    .from("payroll_runs")
    .select(RUN_COLUMNS)
    .eq("id", runId)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const run = mapRunRow(data as unknown as RawRunRow);

  const rawLines = await fetchRawLines(db, tenantId, runId);
  const names = await fetchEmployeeNames(
    db,
    tenantId,
    customerId,
    rawLines.map((l) => l.payroll_employee_id)
  );
  const lines: PayrollRunLine[] = rawLines
    .map((r) => {
      const amounts = mapLineAmounts(r);
      const info = names.get(r.payroll_employee_id);
      return {
        ...amounts,
        employeeFullName: info?.fullName ?? "(ไม่พบพนักงาน)",
        employeeCode: info?.employeeCode ?? null,
      };
    })
    .sort((a, b) => a.employeeFullName.localeCompare(b.employeeFullName, "th"));

  return { run, lines };
}

// ---------------------------------------------------------------------
// recalcRunLines (T114) — idempotent, เรียกซ้ำได้ตลอดตอน draft
// ---------------------------------------------------------------------

export type LineAmountEdit = {
  id: unknown;
  grossSalary: unknown;
  otherAdditions: unknown;
  bonusAmount: unknown;
  otherDeductions: unknown;
};

type ValidatedLineAmountEdit = {
  id: string;
  grossSalary: number;
  otherAdditions: number;
  bonusAmount: number;
  otherDeductions: number;
};

/**
 * validate ยอดที่นักบัญชีแก้ต่อบรรทัด (0.13) — ★★ 0.5 ปฏิเสธ bonus_amount > 0 เสมอ (ปิดสวิตช์ชั่วคราว
 *   จนกว่าจะ verify สูตรภาษีโบนัส, T112) — ปฏิเสธทั้งชุดถ้าบรรทัดใดมี bonus > 0 (ไม่บันทึกบางบรรทัด
 *   บางบรรทัดไม่บันทึก กันสภาพข้อมูลครึ่ง ๆ กลาง ๆ)
 */
function validateLineAmountEdits(
  edits: LineAmountEdit[]
): { ok: true; value: ValidatedLineAmountEdit[] } | { ok: false; message: string } {
  const out: ValidatedLineAmountEdit[] = [];
  for (const e of edits) {
    if (typeof e.id !== "string" || !e.id) return { ok: false, message: "ข้อมูลบรรทัดไม่ถูกต้อง" };
    const gross = parseMoney(e.grossSalary);
    if (gross === null || gross < 0) return { ok: false, message: "เงินเดือน/ค่าจ้างต้องเป็นตัวเลขไม่ติดลบ" };
    const additions = parseMoney(e.otherAdditions);
    if (additions === null || additions < 0) return { ok: false, message: "รายรับเพิ่มเติมต้องเป็นตัวเลขไม่ติดลบ" };
    const bonus = parseMoney(e.bonusAmount);
    if (bonus === null || bonus < 0) return { ok: false, message: "โบนัสต้องเป็นตัวเลขไม่ติดลบ" };
    if (bonus > 0) return { ok: false, message: BONUS_DISABLED_MESSAGE };
    const deductions = parseMoney(e.otherDeductions);
    if (deductions === null || deductions < 0) return { ok: false, message: "รายการหักอื่น ๆ ต้องเป็นตัวเลขไม่ติดลบ" };
    out.push({ id: e.id, grossSalary: gross, otherAdditions: additions, bonusAmount: bonus, otherDeductions: deductions });
  }
  return { ok: true, value: out };
}

export type RecalcResult = { ok: true; lineCount: number } | { ok: false; message: string };

/**
 * บันทึกยอดที่แก้ (ถ้ามี) แล้วคำนวณภาษีหัก ณ ที่จ่าย + ประกันสังคม + เงินเดือนสุทธิใหม่ทุกบรรทัดของรอบ
 *   (idempotent — เรียกซ้ำได้ตลอดตอน status='draft', เขียนทับค่าเดิมได้เสมอ, T114)
 *   ★ ปฏิเสธถ้ารอบ status='finalized' แล้ว (ล็อกแก้หลังสร้าง JE, T115)
 *   ★ grossThisPeriod ที่ annualize = gross_salary + other_additions (ไม่รวม bonus — 0.5 ยังปิดสวิตช์
 *   บังคับเป็น 0 อยู่แล้วจาก validateLineAmountEdits ด้านบน)
 */
export async function recalcRunLines(
  db: DB,
  tenantId: string,
  customerId: string,
  runId: string,
  lineEdits: LineAmountEdit[] = []
): Promise<RecalcResult> {
  const run = await getRunScope(db, tenantId, runId);
  if (!run) return { ok: false, message: "ไม่พบรอบเงินเดือน (อาจถูกลบไปแล้ว)" };
  if (run.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับรอบเงินเดือนนี้" };
  if (run.status !== "draft") {
    return { ok: false, message: "รอบนี้สร้างรายการบัญชีไปแล้ว — คำนวณ/แก้ไขซ้ำไม่ได้ (ล็อกแล้ว)" };
  }

  if (lineEdits.length > 0) {
    const v = validateLineAmountEdits(lineEdits);
    if (!v.ok) return { ok: false, message: v.message };
    for (const e of v.value) {
      await db
        .from("payroll_run_lines")
        .update({
          gross_salary: e.grossSalary,
          other_additions: e.otherAdditions,
          bonus_amount: e.bonusAmount,
          other_deductions: e.otherDeductions,
        })
        .eq("id", e.id)
        .eq("tenant_id", tenantId)
        .eq("run_id", runId);
    }
  }

  const rawLines = await fetchRawLines(db, tenantId, runId);
  if (rawLines.length === 0) return { ok: true, lineCount: 0 };

  const brackets = await getEffectivePitBrackets(db, run.payDate);
  const ssoConfig = await getEffectiveSsoConfig(db, run.payDate);
  if (!brackets || !ssoConfig) {
    return { ok: false, message: "ไม่พบข้อมูลอัตราภาษี/ประกันสังคมที่ใช้ได้ ณ วันที่จ่ายนี้ — ติดต่อผู้ดูแลระบบ" };
  }

  const empIds = rawLines.map((l) => l.payroll_employee_id);
  const startDateByEmp = new Map<string, string | null>();
  const chunks = await Promise.all(
    chunkIds([...new Set(empIds)]).map((chunk) =>
      db.from("payroll_employees").select("id, start_date").eq("tenant_id", tenantId).eq("customer_id", customerId).in("id", chunk)
    )
  );
  for (const { data } of chunks) {
    for (const r of (data ?? []) as { id: string; start_date: string | null }[]) {
      startDateByEmp.set(r.id, r.start_date);
    }
  }

  for (const raw of rawLines) {
    const amounts = mapLineAmounts(raw);
    const periodsPerYear = remainingPeriodsInYear(run.payDate, startDateByEmp.get(raw.payroll_employee_id) ?? null);
    // ★ 0.5 ยังปิดสวิตช์โบนัส — grossThisPeriod ไม่รวม bonusAmount (การันตี = 0 อยู่แล้วจากชั้น validate)
    const grossThisPeriod = round2(amounts.grossSalary + amounts.otherAdditions);
    const pit = calcMonthlyPitForRegularIncome(grossThisPeriod, periodsPerYear, PERSONAL_ALLOWANCE_STANDARD, brackets);
    const sso = calcSsoContribution(grossThisPeriod, ssoConfig);
    const netPay = round2(
      amounts.grossSalary + amounts.otherAdditions + amounts.bonusAmount - pit - sso.employeeContribution - amounts.otherDeductions
    );
    await db
      .from("payroll_run_lines")
      .update({
        pit_withheld: pit,
        sso_employee: sso.employeeContribution,
        sso_employer: sso.employerContribution,
        net_pay: netPay,
      })
      .eq("id", raw.id)
      .eq("tenant_id", tenantId)
      .eq("run_id", runId);
  }

  return { ok: true, lineCount: rawLines.length };
}

// ---------------------------------------------------------------------
// buildPayrollJournalEntry (T115, 0.8) — pure
// ---------------------------------------------------------------------

export type PayrollRunLineAmounts = {
  grossSalary: number;
  otherAdditions: number;
  bonusAmount: number;
  otherDeductions: number;
  pitWithheld: number;
  ssoEmployee: number;
  ssoEmployer: number;
  netPay: number;
};

export type BuildJournalResult = { ok: true; lines: ManualEntryLineInput[] } | { ok: false; message: string };

/**
 * รวมยอดต่อรหัสบัญชี (SUM) ก่อนสร้างบรรทัด JE เสมอ (0.8) — ได้ 4-6 บรรทัดคงที่ไม่ว่าจะมีพนักงานกี่คน:
 *   Dr salary_expense = Σ(gross+additions+bonus) · Dr sso_employer_expense = Σ(sso_employer) [ข้ามถ้า 0]
 *   Cr pit_payable = Σ(pit) [ข้ามถ้า 0] · Cr sso_payable = Σ(sso_employee+sso_employer) [ข้ามถ้า 0]
 *   Cr other_deductions = Σ(other_deductions) [ข้ามถ้า 0 — ถ้า >0 แต่ไม่มีรหัสบัญชีตั้งไว้ → ปฏิเสธ]
 *   Cr net_pay = Σ(net_pay) [ข้ามถ้า 0 — ต้องมีรหัสบัญชีตั้งไว้เสมอไม่ว่าผลรวมจะเป็น 0 หรือไม่ก็ตาม, 0.11]
 *   ★ Dr รวม = Cr รวมเสมอทางพีชคณิต (net_pay = gross+add+bonus−pit−sso_employee−other_deductions ทำให้
 *   Σ(pit)+Σ(sso_employee+sso_employer)+Σ(other_deductions)+Σ(net_pay) = Σ(gross+add+bonus)+Σ(sso_employer)
 *   เป๊ะ — การข้ามบรรทัดที่ยอด=0 ไม่กระทบผลรวม เพราะบวก 0 เข้า/ไม่เข้า ผลรวมเท่ากันเสมอ)
 */
export function buildPayrollJournalEntry(
  lines: PayrollRunLineAmounts[],
  settings: PayrollSettings
): BuildJournalResult {
  if (!settings.netPayAccountCode) {
    return { ok: false, message: "ยังไม่ได้ตั้งรหัสบัญชีเงินเดือนสุทธิ — กรุณาตั้งค่าบัญชีก่อนสร้างรายการบัญชี" };
  }

  let salaryExpense = 0;
  let ssoEmployerExpense = 0;
  let pitPayable = 0;
  let ssoPayable = 0;
  let otherDeductionsPayable = 0;
  let netPayTotal = 0;

  for (const l of lines) {
    salaryExpense = round2(salaryExpense + l.grossSalary + l.otherAdditions + l.bonusAmount);
    ssoEmployerExpense = round2(ssoEmployerExpense + l.ssoEmployer);
    pitPayable = round2(pitPayable + l.pitWithheld);
    ssoPayable = round2(ssoPayable + l.ssoEmployee + l.ssoEmployer);
    otherDeductionsPayable = round2(otherDeductionsPayable + l.otherDeductions);
    netPayTotal = round2(netPayTotal + l.netPay);
  }

  if (otherDeductionsPayable > 0 && !settings.otherDeductionsAccountCode) {
    return {
      ok: false,
      message: "มีรายการหักอื่น ๆ แต่ยังไม่ได้ตั้งรหัสบัญชีหักอื่น ๆ ในตั้งค่า — กรุณาตั้งค่าก่อนสร้างรายการบัญชี",
    };
  }

  const out: ManualEntryLineInput[] = [];
  if (salaryExpense > 0) {
    out.push({ accountCode: settings.salaryExpenseAccountCode, accountName: null, description: "เงินเดือน/ค่าจ้างรวมทั้งรอบ", debit: salaryExpense, credit: 0 });
  }
  if (ssoEmployerExpense > 0) {
    out.push({ accountCode: settings.ssoEmployerExpenseAccountCode, accountName: null, description: "เงินสมทบประกันสังคม (ส่วนนายจ้าง)", debit: ssoEmployerExpense, credit: 0 });
  }
  if (pitPayable > 0) {
    out.push({ accountCode: settings.pitPayableAccountCode, accountName: null, description: "ภาษีหัก ณ ที่จ่าย (ภ.ง.ด.1)", debit: 0, credit: pitPayable });
  }
  if (ssoPayable > 0) {
    out.push({ accountCode: settings.ssoPayableAccountCode, accountName: null, description: "เงินสมทบประกันสังคมค้างนำส่ง (ลูกจ้าง+นายจ้าง)", debit: 0, credit: ssoPayable });
  }
  if (otherDeductionsPayable > 0 && settings.otherDeductionsAccountCode) {
    out.push({ accountCode: settings.otherDeductionsAccountCode, accountName: null, description: "รายการหักอื่น ๆ", debit: 0, credit: otherDeductionsPayable });
  }
  if (netPayTotal > 0) {
    out.push({ accountCode: settings.netPayAccountCode, accountName: null, description: "เงินเดือนสุทธิรวมทั้งรอบ", debit: 0, credit: netPayTotal });
  }

  return { ok: true, lines: out };
}

// ---------------------------------------------------------------------
// generateRunJournalEntry (T115, 0.7/0.9)
// ---------------------------------------------------------------------

export type GenerateJournalEntryResult =
  | { ok: true; manualEntryId: string }
  | { ok: false; message: string; existingManualEntryId?: string | null };

/** revert claim (compensating rollback) — mirror fixed-assets.ts::generateOne ชั้น 2 */
async function revertClaim(db: DB, tenantId: string, runId: string): Promise<void> {
  await db
    .from("payroll_runs")
    .update({ status: "draft" })
    .eq("id", runId)
    .eq("tenant_id", tenantId)
    .eq("status", "finalized")
    .is("manual_entry_id", null);
}

function thaiBuddhistYear(y: number): number {
  // ★ ปีที่เก็บใน pay_period_year เป็น พ.ศ. อยู่แล้ว (check constraint 2500-2700) — ไม่ต้องแปลง
  return y;
}

/**
 * สร้างรายการบัญชี (JE) ของทั้งรอบเป็น "1 ใบรวมยอด" (0.8) เป็น draft เสมอ (0.7) — atomic claim กันกด
 *   ปุ่มซ้ำสอง (0.9, ดูคอมเมนต์เต็มด้านบนไฟล์เรื่อง deviation จาก manual_entry_id ตรง ๆ)
 */
export async function generateRunJournalEntry(
  db: DB,
  tenantId: string,
  customerId: string,
  runId: string,
  chartByCode: ChartByCode
): Promise<GenerateJournalEntryResult> {
  const scope = await getRunScope(db, tenantId, runId);
  if (!scope) return { ok: false, message: "ไม่พบรอบเงินเดือน (อาจถูกลบไปแล้ว)" };
  if (scope.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับรอบเงินเดือนนี้" };
  if (scope.status === "finalized") {
    return { ok: false, message: "รอบนี้สร้างรายการบัญชีไปแล้ว", existingManualEntryId: scope.manualEntryId };
  }

  // ★ 0.9 atomic claim — single UPDATE...WHERE...RETURNING ก่อนเรียก upsertManualEntry เสมอ
  const { data: claimed, error: claimErr } = await db
    .from("payroll_runs")
    .update({ status: "finalized" })
    .eq("id", runId)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("status", "draft")
    .is("manual_entry_id", null)
    .select("id")
    .maybeSingle();
  if (claimErr) return { ok: false, message: "สร้างรายการบัญชีไม่สำเร็จ กรุณาลองใหม่" };
  if (!claimed) {
    const fresh = await getRunScope(db, tenantId, runId);
    return {
      ok: false,
      message: "รอบนี้กำลังสร้างรายการบัญชี หรือสร้างไปแล้ว — ไม่สร้างซ้ำ",
      existingManualEntryId: fresh?.manualEntryId ?? null,
    };
  }

  const settings = await getSettings(db, tenantId, customerId);
  if (!settings) {
    await revertClaim(db, tenantId, runId);
    return { ok: false, message: "ยังไม่ได้ตั้งค่าบัญชีของลูกค้ารายนี้ — กรุณาตั้งค่าก่อนสร้างรายการบัญชี" };
  }

  const rawLines = await fetchRawLines(db, tenantId, runId);
  if (rawLines.length === 0) {
    await revertClaim(db, tenantId, runId);
    return { ok: false, message: "รอบนี้ยังไม่มีพนักงานเลย — สร้างรายการบัญชีไม่ได้" };
  }
  const amounts: PayrollRunLineAmounts[] = rawLines.map(mapLineAmounts);

  const built = buildPayrollJournalEntry(amounts, settings);
  if (!built.ok) {
    await revertClaim(db, tenantId, runId);
    return { ok: false, message: built.message };
  }

  const memo = `เงินเดือนประจำเดือน ${String(scope.payPeriodMonth).padStart(2, "0")}/${thaiBuddhistYear(scope.payPeriodYear)}`;
  const manualInput: ManualEntryInput = {
    docType: "JV",
    docDate: scope.payDate,
    docNo: null,
    memo,
    lines: built.lines,
  };

  // ★ 0.7 upsertManualEntry เดิม insert ใหม่เป็น status='draft' เสมอ — ไม่เรียก confirmManualEntry ที่นี่เด็ดขาด
  const res = await upsertManualEntry(db, tenantId, customerId, manualInput, chartByCode);
  if (!res.ok) {
    await revertClaim(db, tenantId, runId);
    return { ok: false, message: res.message };
  }

  const { error: linkErr } = await db
    .from("payroll_runs")
    .update({ manual_entry_id: res.id })
    .eq("id", runId)
    .eq("tenant_id", tenantId);
  if (linkErr) {
    // ★ JE สร้างสำเร็จแล้วแต่ link ไม่สำเร็จ (DB blip) — ไม่ revert สถานะ finalized (JE มีจริงแล้ว การ revert
    //   จะทำให้กดสร้างซ้ำได้ JE ที่สอง) — คืน ok:true พร้อม manualEntryId เดิม (นักบัญชีเห็น JE ได้จากหน้า
    //   journal-entry ตามปกติแม้ payroll_runs.manual_entry_id ยังไม่อัปเดต — ไม่ใช่ data loss)
    return { ok: true, manualEntryId: res.id };
  }

  return { ok: true, manualEntryId: res.id };
}

// ---------------------------------------------------------------------
// soft-delete รอบ (0.14 — เฉพาะตอน draft)
// ---------------------------------------------------------------------

/** ลบรอบเงินเดือน (soft-delete) — เฉพาะรอบที่ status='draft' (ยังไม่สร้าง JE) เท่านั้น */
export async function softDeleteRun(db: DB, tenantId: string, id: string): Promise<PayrollActionResult> {
  const scope = await getRunScope(db, tenantId, id);
  if (!scope) return { ok: false, message: "ไม่พบรอบเงินเดือน (อาจถูกลบไปแล้ว)" };
  if (scope.status !== "draft") {
    return { ok: false, message: "รอบนี้สร้างรายการบัญชีไปแล้ว — ลบไม่ได้" };
  }
  const { error } = await db
    .from("payroll_runs")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

// ---------------------------------------------------------------------
// markPitFiled/unmarkPitFiled/markSsoFiled/unmarkSsoFiled (T116, 0.3)
// ---------------------------------------------------------------------

async function setFilingStatus(
  db: DB,
  tenantId: string,
  runId: string,
  kind: "pit" | "sso",
  filed: boolean,
  actorEmployeeId: string | null
): Promise<PayrollActionResult> {
  const scope = await getRunScope(db, tenantId, runId);
  if (!scope) return { ok: false, message: "ไม่พบรอบเงินเดือน (อาจถูกลบไปแล้ว)" };
  if (scope.status !== "finalized") {
    return { ok: false, message: "รอบนี้ยังไม่สร้างรายการบัญชี (JE) — บันทึกสถานะยื่นได้เฉพาะรอบที่สร้าง JE แล้ว" };
  }
  const payload =
    kind === "pit"
      ? {
          pit_filing_status: filed ? "filed" : "not_filed",
          pit_filed_at: filed ? new Date().toISOString() : null,
          pit_filed_by: filed ? actorEmployeeId : null,
        }
      : {
          sso_filing_status: filed ? "filed" : "not_filed",
          sso_filed_at: filed ? new Date().toISOString() : null,
          sso_filed_by: filed ? actorEmployeeId : null,
        };
  const { error } = await db.from("payroll_runs").update(payload).eq("id", runId).eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "บันทึกสถานะไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: runId };
}

/** บันทึกว่ายื่น ภ.ง.ด.1 แล้ว — เฉพาะรอบที่ status='finalized' (0.3) */
export function markPitFiled(db: DB, tenantId: string, runId: string, actorEmployeeId: string | null) {
  return setFilingStatus(db, tenantId, runId, "pit", true, actorEmployeeId);
}
/** ยกเลิกสถานะยื่น ภ.ง.ด.1 (undo, 0.3) */
export function unmarkPitFiled(db: DB, tenantId: string, runId: string) {
  return setFilingStatus(db, tenantId, runId, "pit", false, null);
}
/** บันทึกว่ายื่น สปส.1-10 แล้ว — เฉพาะรอบที่ status='finalized' (0.3) */
export function markSsoFiled(db: DB, tenantId: string, runId: string, actorEmployeeId: string | null) {
  return setFilingStatus(db, tenantId, runId, "sso", true, actorEmployeeId);
}
/** ยกเลิกสถานะยื่น สปส.1-10 (undo, 0.3) */
export function unmarkSsoFiled(db: DB, tenantId: string, runId: string) {
  return setFilingStatus(db, tenantId, runId, "sso", false, null);
}
