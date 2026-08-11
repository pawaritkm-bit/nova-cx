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
 * ★★ 0.5 โบนัส — **verify แล้ว เปิดใช้งานจริง** (T112 เสร็จ) — `bonus_amount > 0` คำนวณภาษีผ่าน
 *   `calcMonthlyPitWithBonus` (ป.96/2543 ข้อ 1(5), ดูคอมเมนต์เต็มใน `payroll-tax.ts` ด้านบนไฟล์) แทนการ
 *   ปฏิเสธเหมือนรอบก่อน
 * ★ 0.2 ทุกจุดที่ query พนักงาน ใช้ `payroll-employees.ts` เท่านั้น — ไม่ import จาก accountant-scope.ts/
 *   employees ที่เป็นพนักงานภายใน Finovas ปนกันในไฟล์นี้เด็ดขาด
 * ★ ทุก query/write กรอง tenant_id + customer_id เสมอ — IDOR-safe (0.15) ทำที่ actions.ts ชั้นบนด้วย
 *   requireAccountingAccess + assertCustomerInScope + derive scope จาก resource id ที่กำลังเขียนจริง
 * ★ chunkIds ทุกจุดที่ query `.in()` รายชื่อพนักงานที่อาจมี 100+ คน (0.1, บทเรียน commit 7ab9f91)
 * ★ PDPA: ไม่ log ชื่อพนักงาน/เลขบัตร/เงินเดือน/ชื่อลูกค้าที่ไหนในไฟล์นี้
 * ★★★ เฟส 9b กลุ่ม BC (0.5) — "รอบจ่าย" (payroll_runs) แยกจาก "หน่วยยื่นภาษี/ประกันสังคมรายเดือน"
 *   (payroll_monthly_filings, lib/accounting/payroll-monthly-filing.ts) — createDraftRun ผูก
 *   filing_period_id ทุกรอบใหม่เสมอ (ทั้งลูกค้า monthly/non_monthly) + ปฏิเสธสร้างรอบซ้ำเดือน/ปีเดียวกัน
 *   ที่ชั้นแอปพลิเคชันเมื่อ payroll_settings.pay_frequency='monthly' (ค่า default — regression-safe 100%
 *   กับพฤติกรรมก่อนเฟสนี้ แม้ unique constraint เดิมที่ DB จะถูกเอาออกไปแล้ว) — markPitFiled/unmarkPitFiled/
 *   markSsoFiled/unmarkSsoFiled ย้ายไปทำงานบน payroll_monthly_filings แล้ว (re-export ท้ายไฟล์นี้เพื่อ
 *   backward-compat กันโค้ดอื่น import พัง)
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
  calcMonthlyPitWithBonus,
  calcSsoContribution,
  remainingPeriodsInYear,
  PERSONAL_ALLOWANCE_STANDARD,
} from "@/lib/accounting/payroll-tax";
import { calcProratedGrossSalary } from "@/lib/accounting/payroll-prorate";
import { listEmployees } from "@/lib/accounting/payroll-employees";
import { getSettings, type PayrollSettings } from "@/lib/accounting/payroll-settings";
import { getOrCreateFilingPeriod } from "@/lib/accounting/payroll-monthly-filing";

type DB = SupabaseClient;

export type PayrollRunStatus = "draft" | "finalized";
export type PayrollFilingStatus = "not_filed" | "filed";

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
  /** ★ เฟส 9b กลุ่ม BC — แหล่งข้อมูลจริงของสถานะยื่นคือ payroll_monthly_filings (join ผ่าน filingPeriodId
   *   เสมอ, ดู attachFilingStatus) — ฟิลด์นี้ยังคงชื่อเดิมกันโค้ด/หน้าจอเดิมพัง แต่ค่าที่เห็นมาจากหน่วยยื่น
   *   รายเดือนจริงแล้ว ไม่ใช่คอลัมน์ deprecated บน payroll_runs ตรง ๆ อีกต่อไป */
  pitFilingStatus: PayrollFilingStatus;
  pitFiledAt: string | null;
  pitFiledBy: string | null;
  ssoFilingStatus: PayrollFilingStatus;
  ssoFiledAt: string | null;
  ssoFiledBy: string | null;
  /** ★ เฟส 9b กลุ่ม BC — หน่วยยื่นรายเดือนที่รอบนี้ผูกอยู่ (null เฉพาะแถวเก่าที่หลุด backfill ก่อนเฟสนี้) */
  filingPeriodId: string | null;
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
  /** ★ เฟส 9b กลุ่ม BC — ใช้บันทึกสถานะยื่นที่ระดับหน่วยยื่นรายเดือน (payroll-monthly-filing.ts) */
  filingPeriodId: string | null;
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
  /** ★ เฟส 9b กลุ่ม BB — ข้อมูล badge "prorate อัตโนมัติ" (คำนวณสด ๆ จาก start_date/resign_date ของ
   *   พนักงานเทียบกับงวดของรอบนี้เสมอ — ไม่ผูกกับว่ายอด gross_salary ปัจจุบันถูกแก้ทับไปแล้วหรือไม่ เป็นแค่
   *   ข้อมูลช่วยตัดสินใจของนักบัญชี ไม่ใช่ยอดที่บันทึกจริง) */
  isProrated: boolean;
  proratedDaysWorked: number;
  proratedDaysInMonth: number;
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

  // ★★★ เฟส 9b กลุ่ม BC (T138) — guard ที่ชั้นแอปพลิเคชัน แทน unique constraint เดิมที่ DB (เอาออกแล้วใน
  //   migration 0096 เพื่อให้ลูกค้า non_monthly สร้างหลายรอบ/เดือนได้) — ลูกค้า pay_frequency='monthly'
  //   (ค่า default ของทุกรายที่ไม่มีแถว payroll_settings เลยด้วย) ยังถูกปฏิเสธสร้างรอบซ้ำเดือน/ปีเดียวกัน
  //   เหมือนก่อนเฟสนี้ทุกประการ (ข้อความปฏิเสธเดียวกันเป๊ะ, regression-safe 100%)
  const settings = await getSettings(db, tenantId, customerId);
  const payFrequency = settings?.payFrequency ?? "monthly";
  if (payFrequency === "monthly") {
    const { data: dup } = await db
      .from("payroll_runs")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .eq("pay_period_year", v.value.payPeriodYear)
      .eq("pay_period_month", v.value.payPeriodMonth)
      .is("deleted_at", null)
      .limit(1);
    if (dup && dup.length > 0) {
      return { ok: false, message: "มีรอบเงินเดือนของเดือน/ปีนี้อยู่แล้ว (ลบรอบเดิมก่อนถ้าต้องการสร้างใหม่)" };
    }
  }

  // ★★★ เฟส 9b กลุ่ม BC (T138) — ทุกรอบใหม่ (ทั้ง 2 โหมด) ผูก filing_period_id เสมอ (idempotent get-or-create
  //   ต่อ tenant+customer+ปี+เดือน — หลายรอบจ่ายในเดือนเดียวกันได้แถวเดียวกัน)
  const filingPeriod = await getOrCreateFilingPeriod(db, tenantId, customerId, v.value.payPeriodYear, v.value.payPeriodMonth);
  if (!filingPeriod) {
    return { ok: false, message: "สร้างรอบเงินเดือนไม่สำเร็จ (สร้างหน่วยยื่นภาษี/ประกันสังคมรายเดือนไม่สำเร็จ) กรุณาลองใหม่" };
  }

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
      filing_period_id: filingPeriod.id,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    // ★ defense-in-depth — ปกติ guard ด้านบนกันไว้แล้วสำหรับลูกค้า monthly แต่ถ้า race เกิดขึ้นจริง (2 request
    //   พร้อมกัน) ยังต้องรับมือ error message เดียวกัน (ไม่มี unique constraint ที่ DB แล้วหลัง 0096 แต่คง
    //   branch นี้ไว้เผื่อ deploy ข้ามช่วง migration หรือ DB error อื่นที่มี code เดียวกันโดยบังเอิญ)
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
    // ★★ เฟส 9b กลุ่ม BB — prefill ด้วย calcProratedGrossSalary เฉพาะพนักงานที่ start_date/resign_date
    //   ตกอยู่ในช่วงเดือนของรอบนี้เท่านั้น — พนักงานปกตินอกช่วง (ทำงานเต็มเดือน) ยังได้ prorated===baseSalary
    //   เป๊ะ (isProrated=false) ไม่มีการปัดเศษเพี้ยน (regression-safe 100% กับพฤติกรรมก่อนเฟสนี้)
    const rows = chunk.map((id) => {
      const emp = byId.get(id);
      const base = emp?.baseSalary ?? 0;
      const { prorated } = calcProratedGrossSalary(
        base,
        v.value.payPeriodYear,
        v.value.payPeriodMonth,
        emp?.startDate ?? null,
        emp?.resignDate ?? null
      );
      return {
        tenant_id: tenantId,
        run_id: runId,
        payroll_employee_id: id,
        gross_salary: prorated,
        other_additions: 0,
        bonus_amount: 0,
        other_deductions: 0,
        pit_withheld: 0,
        sso_employee: 0,
        sso_employer: 0,
        net_pay: 0,
      };
    });
    if (rows.length > 0) {
      const { error: lineErr } = await db.from("payroll_run_lines").insert(rows);
      // ★★ แก้บั๊ก QC เฟส 9: เดิมไม่เช็ค error ปล่อยผ่านเงียบ ๆ — ถ้า insert chunk ใดล้มเหลว (เช่น DB blip
      //   ชั่วคราว) ฟังก์ชันยังคืนสำเร็จปกติ ทำให้รอบเงินเดือนมีพนักงานไม่ครบแบบไม่มีใครรู้ — compensating
      //   rollback: ลบรอบที่เพิ่งสร้าง (ยังเป็น draft สด ๆ ไม่มี JE แน่นอน จึง soft-delete ตรงได้ปลอดภัย ไม่ต้อง
      //   ผ่าน softDeleteRun ที่เช็ค status ซ้ำอีกชั้น) กันสภาพข้อมูลครึ่ง ๆ กลาง ๆ ให้นักบัญชีลองสร้างใหม่ได้สะอาด
      if (lineErr) {
        await db.from("payroll_runs").update({ deleted_at: new Date().toISOString() }).eq("id", runId).eq("tenant_id", tenantId);
        return { ok: false, message: "สร้างรอบเงินเดือนไม่สำเร็จ (บันทึกพนักงานไม่ครบ) กรุณาลองใหม่" };
      }
    }
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
  filing_period_id: string | null;
  created_at: string;
  updated_at: string;
};

const RUN_COLUMNS =
  "id, tenant_id, customer_id, pay_period_year, pay_period_month, pay_date, status, manual_entry_id, pit_filing_status, pit_filed_at, pit_filed_by, sso_filing_status, sso_filed_at, sso_filed_by, filing_period_id, created_at, updated_at";

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
    // ★ ค่าเริ่มต้นจากคอลัมน์ deprecated บน payroll_runs เอง (เผื่อ filingPeriodId เป็น null — แถวเก่าที่
    //   หลุด backfill) — attachFilingStatus (เรียกจาก listRuns/getRunWithLines) จะ overlay ทับด้วยค่าจริง
    //   จาก payroll_monthly_filings เสมอเมื่อมี filingPeriodId
    pitFilingStatus: (r.pit_filing_status as PayrollFilingStatus) ?? "not_filed",
    pitFiledAt: r.pit_filed_at,
    pitFiledBy: r.pit_filed_by,
    ssoFilingStatus: (r.sso_filing_status as PayrollFilingStatus) ?? "not_filed",
    ssoFiledAt: r.sso_filed_at,
    ssoFiledBy: r.sso_filed_by,
    filingPeriodId: r.filing_period_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * ★ เฟส 9b กลุ่ม BC — overlay สถานะยื่นจริงจาก payroll_monthly_filings ทับค่าเริ่มต้น (คอลัมน์ deprecated
 *   บน payroll_runs) ตาม filingPeriodId ของแต่ละรอบ — ให้หน้าจอเห็นสถานะที่ถูกต้องเสมอไม่ว่าจะบันทึกว่ายื่น
 *   จากหน้า filing/ (ระดับเดือน) เท่านั้นก็ตาม (payroll_runs เดิมไม่ถูกเขียนทับสถานะพวกนี้ต่อแล้ว)
 */
async function attachFilingStatus(db: DB, tenantId: string, runs: PayrollRun[]): Promise<PayrollRun[]> {
  const periodIds = [...new Set(runs.map((r) => r.filingPeriodId).filter((x): x is string => !!x))];
  if (periodIds.length === 0) return runs;

  const map = new Map<
    string,
    { pit: PayrollFilingStatus; pitAt: string | null; pitBy: string | null; sso: PayrollFilingStatus; ssoAt: string | null; ssoBy: string | null }
  >();
  const chunks = await Promise.all(
    chunkIds(periodIds).map((chunk) =>
      db
        .from("payroll_monthly_filings")
        .select("id, pit_filing_status, pit_filed_at, pit_filed_by, sso_filing_status, sso_filed_at, sso_filed_by")
        .eq("tenant_id", tenantId)
        .in("id", chunk)
    )
  );
  for (const { data } of chunks) {
    for (const f of (data ?? []) as {
      id: string;
      pit_filing_status: string;
      pit_filed_at: string | null;
      pit_filed_by: string | null;
      sso_filing_status: string;
      sso_filed_at: string | null;
      sso_filed_by: string | null;
    }[]) {
      map.set(f.id, {
        pit: (f.pit_filing_status as PayrollFilingStatus) ?? "not_filed",
        pitAt: f.pit_filed_at,
        pitBy: f.pit_filed_by,
        sso: (f.sso_filing_status as PayrollFilingStatus) ?? "not_filed",
        ssoAt: f.sso_filed_at,
        ssoBy: f.sso_filed_by,
      });
    }
  }

  return runs.map((r) => {
    if (!r.filingPeriodId) return r;
    const f = map.get(r.filingPeriodId);
    if (!f) return r;
    return {
      ...r,
      pitFilingStatus: f.pit,
      pitFiledAt: f.pitAt,
      pitFiledBy: f.pitBy,
      ssoFilingStatus: f.sso,
      ssoFiledAt: f.ssoAt,
      ssoFiledBy: f.ssoBy,
    };
  });
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
  const runs = (data as unknown as RawRunRow[]).map(mapRunRow);
  return attachFilingStatus(db, tenantId, runs);
}

/** โหลดสโคป+สถานะของรอบ 1 รอบ (scope tenant) — ใช้ตรวจสโคปก่อนแก้/ลบ/สร้าง JE ทุกครั้ง (0.15) */
export async function getRunScope(db: DB, tenantId: string, id: string): Promise<PayrollRunScope | null> {
  const { data } = await db
    .from("payroll_runs")
    .select("customer_id, status, manual_entry_id, pay_date, pay_period_year, pay_period_month, filing_period_id")
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
    filing_period_id: string | null;
  };
  return {
    customerId: r.customer_id,
    status: (r.status as PayrollRunStatus) ?? "draft",
    manualEntryId: r.manual_entry_id,
    payDate: r.pay_date,
    payPeriodYear: r.pay_period_year,
    payPeriodMonth: r.pay_period_month,
    filingPeriodId: r.filing_period_id ?? null,
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
 * ข้อมูลพนักงาน (fullName/employeeCode/start_date/resign_date) ของ payrollEmployeeIds ที่ระบุ — chunkIds
 *   กัน `.in()` ยาวเกิน limit เมื่อลูกค้ามีพนักงาน 100+ คน (0.1, บทเรียน commit 7ab9f91)
 *   ★ เฟส 9b กลุ่ม BB — เพิ่ม start_date/resign_date เพื่อคำนวณ badge "prorate อัตโนมัติ" ตอนแสดงผล
 *   (getRunWithLines) — ไม่กระทบยอด gross_salary ที่บันทึกจริงเลย (แค่ข้อมูลช่วยตัดสินใจของนักบัญชี)
 */
async function fetchEmployeeInfo(
  db: DB,
  tenantId: string,
  customerId: string,
  ids: string[]
): Promise<
  Map<string, { fullName: string; employeeCode: string | null; startDate: string | null; resignDate: string | null }>
> {
  const map = new Map<
    string,
    { fullName: string; employeeCode: string | null; startDate: string | null; resignDate: string | null }
  >();
  const uniqIds = [...new Set(ids)];
  if (uniqIds.length === 0) return map;
  const chunks = await Promise.all(
    chunkIds(uniqIds).map((chunk) =>
      db
        .from("payroll_employees")
        .select("id, full_name, employee_code, start_date, resign_date")
        .eq("tenant_id", tenantId)
        .eq("customer_id", customerId)
        .in("id", chunk)
    )
  );
  for (const { data } of chunks) {
    for (const r of (data ?? []) as {
      id: string;
      full_name: string;
      employee_code: string | null;
      start_date: string | null;
      resign_date: string | null;
    }[]) {
      map.set(r.id, { fullName: r.full_name, employeeCode: r.employee_code, startDate: r.start_date, resignDate: r.resign_date });
    }
  }
  return map;
}

function mapLineAmounts(
  r: RawLineRow
): Omit<PayrollRunLine, "employeeFullName" | "employeeCode" | "isProrated" | "proratedDaysWorked" | "proratedDaysInMonth"> {
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
  const [run] = await attachFilingStatus(db, tenantId, [mapRunRow(data as unknown as RawRunRow)]);

  const rawLines = await fetchRawLines(db, tenantId, runId);
  const info = await fetchEmployeeInfo(
    db,
    tenantId,
    customerId,
    rawLines.map((l) => l.payroll_employee_id)
  );
  const lines: PayrollRunLine[] = rawLines
    .map((r) => {
      const amounts = mapLineAmounts(r);
      const emp = info.get(r.payroll_employee_id);
      // ★ BB — badge คำนวณสด ๆ จาก base_salary ปัจจุบันของบรรทัด (amounts.grossSalary) เทียบ start/resign
      //   date ของพนักงาน — ใช้แค่ daysWorked/daysInMonth/isProrated (ไม่ใช้ผลลัพธ์ prorated ที่คืนมา เพราะ
      //   ยอดจริงที่บันทึกอาจถูกนักบัญชีแก้ทับไปแล้ว, 0.13)
      const prorate = calcProratedGrossSalary(
        amounts.grossSalary,
        run.payPeriodYear,
        run.payPeriodMonth,
        emp?.startDate ?? null,
        emp?.resignDate ?? null
      );
      return {
        ...amounts,
        employeeFullName: emp?.fullName ?? "(ไม่พบพนักงาน)",
        employeeCode: emp?.employeeCode ?? null,
        isProrated: prorate.isProrated,
        proratedDaysWorked: prorate.daysWorked,
        proratedDaysInMonth: prorate.daysInMonth,
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
 * validate ยอดที่นักบัญชีแก้ต่อบรรทัด (0.13) — ★★ 0.5 bonus_amount > 0 เปิดใช้งานแล้ว (verify สูตรภาษี
 *   โบนัสตามคำสั่งกรมสรรพากรที่ ป.96/2543 ข้อ 1(5) เสร็จแล้ว, T112) — คงเหลือแค่ตรวจว่าเป็นตัวเลขไม่ติดลบ
 *   เหมือนช่องเงินอื่น ๆ ทุกประการ
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
 *   ★ grossThisPeriod ที่ annualize (สำหรับเงินได้ประจำ + ฐาน SSO) = gross_salary + other_additions
 *   (ไม่รวม bonus — bonus คำนวณแยกเป็นเงินได้ครั้งเดียวผ่าน `calcMonthlyPitWithBonus`, 0.5, verify แล้ว/
 *   เปิดใช้งานจริง)
 *   ★★ แก้บั๊ก QC เฟส 9: net_pay ไม่มี DB check constraint `>=0` และไม่มีชั้นไหนกันไว้มาก่อน — ถ้า
 *   other_deductions ที่นักบัญชีกรอกมากกว่ารายรับสุทธิของพนักงานคนนั้นจริง (gross+add+bonus−pit−sso_employee
 *   −other_deductions < 0) จะทำให้ net_pay ติดลบ แล้วภายหลัง buildPayrollJournalEntry ตัดบรรทัด Cr net_pay
 *   ทิ้ง (เพราะเช็คแค่ `>0`) ทำ JE ไม่สมดุลแบบเงียบ ๆ — ป้องกันที่ต้นเหตุตรงนี้แทน: คำนวณทุกบรรทัดก่อน (ยังไม่เขียน
 *   DB) แล้วตรวจ net_pay ติดลบทั้งชุดก่อนเขียนบรรทัดใดเลย ถ้าพบให้ปฏิเสธทั้งชุดพร้อมชื่อพนักงาน+สาเหตุชัดเจน
 *   (เหมือน pattern ปฏิเสธทั้งชุดของ validateLineAmountEdits/0.5 ด้านบน — ไม่บันทึกครึ่ง ๆ กลาง ๆ)
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
      const { error } = await db
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
      // ★★ แก้บั๊ก QC เฟส 9: เดิมไม่เช็ค error ปล่อยผ่านเงียบ ๆ — ถ้า update บรรทัดใดล้มเหลว ยอดที่นักบัญชี
      //   แก้ไม่ครบทุกบรรทัดแต่ฟังก์ชันคืนสำเร็จเหมือนเดิม (idempotent — เรียกซ้ำได้ ไม่เสี่ยง data loss ถาวร)
      if (error) return { ok: false, message: "บันทึกยอดที่แก้ไขไม่สำเร็จ กรุณาลองใหม่" };
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
  // ★★ เฟส 9b กลุ่ม BA — โหลด sso_exempt คู่กับ start_date ต่อพนักงาน (0.3)
  const ssoExemptByEmp = new Map<string, boolean>();
  const chunks = await Promise.all(
    chunkIds([...new Set(empIds)]).map((chunk) =>
      db
        .from("payroll_employees")
        .select("id, start_date, sso_exempt")
        .eq("tenant_id", tenantId)
        .eq("customer_id", customerId)
        .in("id", chunk)
    )
  );
  for (const { data } of chunks) {
    for (const r of (data ?? []) as { id: string; start_date: string | null; sso_exempt: boolean | null }[]) {
      startDateByEmp.set(r.id, r.start_date);
      ssoExemptByEmp.set(r.id, !!r.sso_exempt);
    }
  }

  // ★★ ชั้น 1: คำนวณทุกบรรทัดก่อน (ยังไม่เขียน DB) — ให้ตรวจ net_pay ติดลบได้ทั้งชุดก่อนบันทึกจริงบรรทัดใดเลย
  type Computed = { rawId: string; payrollEmployeeId: string; pit: number; ssoEmployee: number; ssoEmployer: number; netPay: number };
  const computed: Computed[] = [];
  for (const raw of rawLines) {
    const amounts = mapLineAmounts(raw);
    const periodsPerYear = remainingPeriodsInYear(run.payDate, startDateByEmp.get(raw.payroll_employee_id) ?? null);
    // ★ grossThisPeriod (ฐาน annualize เงินได้ประจำ + ฐาน SSO) ไม่รวม bonusAmount เสมอ — bonus ถูกส่งเข้า
    //   calcMonthlyPitWithBonus แยกเป็นพารามิเตอร์ของตัวเอง (0.5, verify แล้ว) ไม่ผสมเข้า grossThisPeriod
    const grossThisPeriod = round2(amounts.grossSalary + amounts.otherAdditions);
    const pit = calcMonthlyPitWithBonus(grossThisPeriod, amounts.bonusAmount, periodsPerYear, PERSONAL_ALLOWANCE_STANDARD, brackets).totalPit;
    // ★★ เฟส 9b กลุ่ม BA (0.3) — ข้าม calcSsoContribution เมื่อ sso_exempt=true (employee/employer=0 เสมอ
    //   ไม่ว่าค่าจ้างเท่าไหร่) — เงื่อนไขก่อนเรียกเท่านั้น ไม่แก้ calcSsoContribution เอง
    const isSsoExempt = ssoExemptByEmp.get(raw.payroll_employee_id) ?? false;
    const sso = isSsoExempt
      ? { wageBase: 0, employeeContribution: 0, employerContribution: 0 }
      : calcSsoContribution(grossThisPeriod, ssoConfig);
    const netPay = round2(
      amounts.grossSalary + amounts.otherAdditions + amounts.bonusAmount - pit - sso.employeeContribution - amounts.otherDeductions
    );
    computed.push({
      rawId: raw.id,
      payrollEmployeeId: raw.payroll_employee_id,
      pit,
      ssoEmployee: sso.employeeContribution,
      ssoEmployer: sso.employerContribution,
      netPay,
    });
  }

  // ★★ แก้บั๊ก QC เฟส 9 (ต้นเหตุ): net_pay ต่อพนักงานติดลบต้องถูกปฏิเสธที่นี่เลย ไม่ปล่อยให้บันทึกลง DB แล้วไป
  //   พังตอนสร้าง JE ทีหลังแบบไม่บอกสาเหตุจริง — ระบุชื่อพนักงานคนแรกที่พบให้นักบัญชีแก้ตรงจุดได้ทันที
  //   (ข้อความนี้คืนกลับตรง ๆ ให้นักบัญชีที่กำลังทำรอบเงินเดือนของลูกค้ารายนี้อยู่แล้วเห็นเป็น toast/inline เท่านั้น
  //   ไม่ใช่การ log ลงที่เก็บถาวรใด ๆ — ไม่ขัดกับ PDPA note ด้านบนไฟล์ที่ห้าม log ชื่อพนักงาน)
  const negative = computed.find((c) => c.netPay < 0);
  if (negative) {
    const names = await fetchEmployeeInfo(db, tenantId, customerId, [negative.payrollEmployeeId]);
    const name = names.get(negative.payrollEmployeeId)?.fullName ?? "(ไม่พบพนักงาน)";
    return {
      ok: false,
      message: `เงินเดือนสุทธิของพนักงาน "${name}" ติดลบ (${negative.netPay.toFixed(2)} บาท) — ยอดหักอื่น ๆ อาจมากกว่ารายรับสุทธิ กรุณาตรวจสอบยอดหักอื่น ๆ ของพนักงานคนนี้`,
    };
  }

  for (const c of computed) {
    const { error } = await db
      .from("payroll_run_lines")
      .update({
        pit_withheld: c.pit,
        sso_employee: c.ssoEmployee,
        sso_employer: c.ssoEmployer,
        net_pay: c.netPay,
      })
      .eq("id", c.rawId)
      .eq("tenant_id", tenantId)
      .eq("run_id", runId);
    // ★★ แก้บั๊ก QC เฟส 9: เดิมไม่เช็ค error ปล่อยผ่านเงียบ ๆ — ถ้า update บรรทัดใดล้มเหลว ผลคำนวณไม่ครบทุกบรรทัด
    //   แต่ฟังก์ชันคืนสำเร็จเหมือนเดิม (idempotent — เรียกซ้ำได้ปลอดภัย ไม่เสี่ยง data loss ถาวร)
    if (error) return { ok: false, message: "บันทึกผลคำนวณภาษี/ประกันสังคมไม่สำเร็จ กรุณาลองใหม่" };
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
 *   ★★ แก้บั๊ก QC เฟส 9: ถ้า Σ(net_pay) ติดลบ (สุดวิสัย — recalcRunLines กันไว้แล้วไม่ให้ net_pay ต่อพนักงานติดลบ
 *   ตั้งแต่ต้นเหตุ) บรรทัดนี้กลับขั้วเป็น Dr แทน (ห้ามใส่ credit ติดลบ — ดูคอมเมนต์เต็มในฟังก์ชันตรงเงื่อนไข)
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
  // ★★ แก้บั๊ก QC เฟส 9: เดิมใช้ `if (netPayTotal > 0)` เฉย ๆ — ถ้า netPayTotal เป็น 0 หรือติดลบ (net_pay ต่อ
  //   พนักงานติดลบ เช่น other_deductions มากกว่ารายรับสุทธิ) โค้ดเดิมจะไม่ใส่บรรทัด Cr net_pay เข้า JE เลย
  //   ทำให้ Dr รวม ≠ Cr รวม แล้ว upsertManualEntry ปฏิเสธด้วยข้อความ generic ที่ไม่บอกสาเหตุจริง — ตอนนี้ป้องกัน
  //   ที่ต้นเหตุแล้วใน recalcRunLines (ปฏิเสธไม่ให้ net_pay ต่อพนักงานติดลบตั้งแต่คำนวณ) แต่ยังกันไว้ที่ชั้นนี้ด้วย
  //   (defense-in-depth เผื่อข้อมูลเก่าก่อนมี validation หลุดเข้ามา):
  //   - netPayTotal = 0 พอดี (พนักงานทุกคนสุทธิ 0 บาทเป๊ะ) ก็ยังต้องมีรหัสบัญชีตั้งไว้ (เช็คแล้วด้านบนสุดของฟังก์ชัน)
  //     แต่ไม่ต้องใส่บรรทัด (0 บาทไม่มีความหมายทางบัญชี, 0.11)
  //   - netPayTotal < 0 (สุดวิสัย — ไม่ควรเกิดขึ้นจริงเพราะกันไว้แล้วที่ recalcRunLines) ห้ามใส่ credit ติดลบเด็ดขาด
  //     (manual-journal.ts::asAmount clamp ค่าติดลบเป็น 0 ทำให้บรรทัดว่างทั้ง debit/credit แล้วโดนปฏิเสธด้วย
  //     ข้อความ generic "ต้องระบุยอดเดบิตหรือเครดิต" ที่ไม่บอกสาเหตุจริงเหมือนเดิม) — กลับขั้วเป็น Dr แทน ยังคง
  //     Dr รวม = Cr รวม ทางพีชคณิตเดิมเสมอ (พิสูจน์: Dr_total = salaryExpense+ssoEmployerExpense,
  //     Cr_total_อื่น = pitPayable+ssoPayable+otherDeductionsPayable = Dr_total − netPayTotal ตามสูตร netPay
  //     ด้านบน — ถ้า netPayTotal ติดลบ Cr_total_อื่น > Dr_total อยู่ |netPayTotal| พอดี ต้องเพิ่ม Dr ฝั่งนี้เท่านั้นถึงจะสมดุล)
  if (settings.netPayAccountCode && netPayTotal !== 0) {
    if (netPayTotal > 0) {
      out.push({ accountCode: settings.netPayAccountCode, accountName: null, description: "เงินเดือนสุทธิรวมทั้งรอบ", debit: 0, credit: netPayTotal });
    } else {
      out.push({
        accountCode: settings.netPayAccountCode,
        accountName: null,
        description: "เงินเดือนสุทธิรวมทั้งรอบ (ติดลบ — พบยอดหักเกินรายรับสุทธิ กรุณาตรวจสอบยอดหักของพนักงาน)",
        debit: -netPayTotal,
        credit: 0,
      });
    }
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
// markPitFiled/unmarkPitFiled/markSsoFiled/unmarkSsoFiled — ย้ายไป payroll-monthly-filing.ts (เฟส 9b
//   กลุ่ม BC, T137) เพราะสถานะยื่นตัวจริงอยู่ที่ระดับ "หน่วยยื่นรายเดือน" (payroll_monthly_filings) ไม่ใช่
//   ระดับ "รอบจ่าย" (payroll_runs) อีกต่อไป — ★ deprecated ในไฟล์นี้ คงไว้เป็น re-export เท่านั้นกันโค้ดอื่น
//   import จาก "@/lib/accounting/payroll" พัง — ★★ พารามิเตอร์ที่ 3 เปลี่ยนความหมายจาก runId เป็น
//   filingPeriodId (ผู้เรียกต้อง resolve filingPeriodId จาก getRunScope(...).filingPeriodId ก่อนเสมอ ดู
//   app/chat-audit/accounting/payroll/actions.ts::markFiledAction เป็นตัวอย่าง)
// ---------------------------------------------------------------------
export { markPitFiled, unmarkPitFiled, markSsoFiled, unmarkSsoFiled } from "@/lib/accounting/payroll-monthly-filing";
