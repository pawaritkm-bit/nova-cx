/**
 * หน่วยยื่นภาษี/ประกันสังคมรายเดือน (payroll_monthly_filings) — เจ้าของสถานะยื่น ภ.ง.ด.1/สปส.1-10 ตัวจริง
 *   (1 แถวต่อ tenant+customer+ปี+เดือน) แยกออกจาก "รอบจ่าย" (payroll_runs) — เฟส 9b กลุ่ม BC
 *   (docs/06-accounting-features-roadmap.md, หมวด 0.5)
 *
 * บริบท: ภ.ง.ด.1/สปส.1-10 เป็นภาระผูกพันรายเดือนเสมอไม่ว่าลูกค้าจะจ่ายเงินเดือนถี่แค่ไหน (รายเดือน/รายสัปดาห์/
 *   รายปักษ์) — `payroll_runs.filing_period_id` (migration 0095) ชี้มาที่แถวในตารางนี้ หลายรอบจ่ายในเดือน
 *   เดียวกันชี้แถวเดียวกันได้ (getOrCreateFilingPeriod การันตี idempotent ต่อ tenant+customer+ปี+เดือน)
 *
 * ★ markPitFiled/unmarkPitFiled/markSsoFiled/unmarkSsoFiled ย้ายมาจาก payroll.ts (เดิมทำงานบน payroll_runs
 *   ตรง ๆ — 1 รอบ = 1 การยื่น) มาทำงานบน payroll_monthly_filings แทน — payroll.ts เก็บไว้เป็น re-export
 *   ชั่วคราวกันโค้ดอื่น import พัง (ดูคอมเมนต์ท้าย payroll.ts)
 * ★ guard mark filed: อนุญาตเฉพาะหน่วยยื่นที่มีอย่างน้อย 1 รอบจ่าย status='finalized' ผูกอยู่ (มี JE แล้ว) —
 *   ปฏิเสธถ้ายังไม่มีรอบไหน finalized เลย (mirror เงื่อนไขเดิมของ payroll.ts::setFilingStatus ที่เคยเช็คที่
 *   ระดับรอบเดียว ตอนนี้เช็คว่า "มีรอบไหนในเดือนนี้ finalized แล้วบ้าง" แทน)
 * ★ ทุก query/write กรอง tenant_id (+ customer_id เมื่อมี) เสมอ — IDOR-safe (0.15) ทำที่ actions.ts ชั้นบนด้วย
 *   requireAccountingAccess + assertCustomerInScope + derive scope จาก resource id ที่กำลังเขียนจริง
 * ★ PDPA: ไม่ log ชื่อพนักงาน/เลขบัตร/เงินเดือน/ชื่อลูกค้าที่ไหนในไฟล์นี้
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/accounting/queries";
import { chunkIds } from "@/lib/accounting/id-chunk";

type DB = SupabaseClient;

export type FilingStatus = "not_filed" | "filed";

const FILING_LIST_LIMIT = 500;

export type PayrollMonthlyFiling = {
  id: string;
  tenantId: string;
  customerId: string;
  periodYear: number;
  periodMonth: number;
  pitFilingStatus: FilingStatus;
  pitFiledAt: string | null;
  pitFiledBy: string | null;
  ssoFilingStatus: FilingStatus;
  ssoFiledAt: string | null;
  ssoFiledBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FilingActionResult = { ok: true; id: string } | { ok: false; message: string };

type RawFilingRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  period_year: number;
  period_month: number;
  pit_filing_status: string;
  pit_filed_at: string | null;
  pit_filed_by: string | null;
  sso_filing_status: string;
  sso_filed_at: string | null;
  sso_filed_by: string | null;
  created_at: string;
  updated_at: string;
};

const FILING_COLUMNS =
  "id, tenant_id, customer_id, period_year, period_month, pit_filing_status, pit_filed_at, pit_filed_by, sso_filing_status, sso_filed_at, sso_filed_by, created_at, updated_at";

function mapFilingRow(r: RawFilingRow): PayrollMonthlyFiling {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    periodYear: r.period_year,
    periodMonth: r.period_month,
    pitFilingStatus: (r.pit_filing_status as FilingStatus) ?? "not_filed",
    pitFiledAt: r.pit_filed_at,
    pitFiledBy: r.pit_filed_by,
    ssoFilingStatus: (r.sso_filing_status as FilingStatus) ?? "not_filed",
    ssoFiledAt: r.sso_filed_at,
    ssoFiledBy: r.sso_filed_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** โหลดหน่วยยื่น 1 แถวจาก id (scope tenant) — คืน null ถ้าไม่พบ */
export async function getFilingPeriodById(db: DB, tenantId: string, id: string): Promise<PayrollMonthlyFiling | null> {
  const { data } = await db
    .from("payroll_monthly_filings")
    .select(FILING_COLUMNS)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!data) return null;
  return mapFilingRow(data as unknown as RawFilingRow);
}

/** โหลดหน่วยยื่นตามปี/เดือน (อ่านล้วน — ไม่สร้างใหม่ถ้าไม่พบ ใช้เฉพาะแสดงผล ไม่มี side-effect ตอน GET) */
export async function getFilingPeriodByYearMonth(
  db: DB,
  tenantId: string,
  customerId: string,
  periodYear: number,
  periodMonth: number
): Promise<PayrollMonthlyFiling | null> {
  const { data } = await db
    .from("payroll_monthly_filings")
    .select(FILING_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("period_year", periodYear)
    .eq("period_month", periodMonth)
    .maybeSingle();
  if (!data) return null;
  return mapFilingRow(data as unknown as RawFilingRow);
}

/**
 * idempotent get-or-create ต่อ (tenant, customer, ปี, เดือน) — เรียกซ้ำด้วยคีย์เดิมคืนแถวเดียวกันเสมอ (T137)
 *   ใช้ตอนสร้างรอบเงินเดือนใหม่ทุกรอบ (payroll.ts::createDraftRun) ทั้งลูกค้า monthly/non_monthly —
 *   หลายรอบจ่ายในเดือนเดียวกันได้ filing_period_id เดียวกัน (unique index ของ 0094 การันตีที่ชั้น DB)
 *   คืน null เฉพาะกรณี DB ผิดปกติจริง (ไม่ใช่ race ปกติ — race ถูกจัดการด้วย on-conflict-retry ในตัว)
 */
export async function getOrCreateFilingPeriod(
  db: DB,
  tenantId: string,
  customerId: string,
  periodYear: number,
  periodMonth: number
): Promise<PayrollMonthlyFiling | null> {
  const existing = await getFilingPeriodByYearMonth(db, tenantId, customerId, periodYear, periodMonth);
  if (existing) return existing;

  const { data, error } = await db
    .from("payroll_monthly_filings")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      period_year: periodYear,
      period_month: periodMonth,
      pit_filing_status: "not_filed",
      pit_filed_at: null,
      pit_filed_by: null,
      sso_filing_status: "not_filed",
      sso_filed_at: null,
      sso_filed_by: null,
    })
    .select(FILING_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    // ★ race เผื่อมีคนอื่นสร้างพร้อมกันพอดี (unique tenant+customer+ปี+เดือน) — โหลดของจริงกลับมาแทนล้มเหลว
    const retry = await getFilingPeriodByYearMonth(db, tenantId, customerId, periodYear, periodMonth);
    return retry;
  }
  return mapFilingRow(data as unknown as RawFilingRow);
}

/** รายการหน่วยยื่นทั้งหมดของลูกค้า 1 ราย เรียงปี/เดือนล่าสุดก่อน (สำหรับหน้าสรุปการยื่นรายเดือน, T139) */
export async function listFilingPeriods(db: DB, tenantId: string, customerId: string): Promise<PayrollMonthlyFiling[]> {
  const { data, error } = await db
    .from("payroll_monthly_filings")
    .select(FILING_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .order("period_year", { ascending: false })
    .order("period_month", { ascending: false })
    .limit(FILING_LIST_LIMIT);
  if (error || !data) return [];
  return (data as unknown as RawFilingRow[]).map(mapFilingRow);
}

export type FilingPeriodRunSummary = {
  id: string;
  payDate: string;
  status: "draft" | "finalized";
  totalPit: number;
  totalSsoEmployee: number;
  totalSsoEmployer: number;
  totalNetPay: number;
};

export type FilingPeriodDetail = {
  period: PayrollMonthlyFiling;
  runs: FilingPeriodRunSummary[];
};

/**
 * รายละเอียดหน่วยยื่น 1 เดือน — ทุกรอบจ่ายที่รวมอยู่ในเดือนนั้น + ยอดรวม PIT/SSO/net_pay ต่อรอบ (T139)
 *   คืน null ถ้าไม่พบ/ลูกค้าไม่ตรง
 */
export async function getFilingPeriodDetail(
  db: DB,
  tenantId: string,
  customerId: string,
  filingPeriodId: string
): Promise<FilingPeriodDetail | null> {
  const period = await getFilingPeriodById(db, tenantId, filingPeriodId);
  if (!period || period.customerId !== customerId) return null;

  const { data: runRows } = await db
    .from("payroll_runs")
    .select("id, pay_date, status")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("filing_period_id", filingPeriodId)
    .is("deleted_at", null)
    .order("pay_date", { ascending: true });

  const rows = (runRows ?? []) as { id: string; pay_date: string; status: string }[];
  const runIds = rows.map((r) => r.id);
  const lineChunks = await Promise.all(
    chunkIds(runIds).map((chunk) =>
      db
        .from("payroll_run_lines")
        .select("run_id, pit_withheld, sso_employee, sso_employer, net_pay")
        .eq("tenant_id", tenantId)
        .in("run_id", chunk)
    )
  );
  const totalsByRun = new Map<string, { pit: number; ssoEmp: number; ssoEmpr: number; net: number }>();
  for (const { data } of lineChunks) {
    for (const l of (data ?? []) as {
      run_id: string;
      pit_withheld: number | string;
      sso_employee: number | string;
      sso_employer: number | string;
      net_pay: number | string;
    }[]) {
      const acc = totalsByRun.get(l.run_id) ?? { pit: 0, ssoEmp: 0, ssoEmpr: 0, net: 0 };
      acc.pit += Number(l.pit_withheld);
      acc.ssoEmp += Number(l.sso_employee);
      acc.ssoEmpr += Number(l.sso_employer);
      acc.net += Number(l.net_pay);
      totalsByRun.set(l.run_id, acc);
    }
  }

  const runs: FilingPeriodRunSummary[] = rows.map((r) => {
    const t = totalsByRun.get(r.id) ?? { pit: 0, ssoEmp: 0, ssoEmpr: 0, net: 0 };
    return {
      id: r.id,
      payDate: r.pay_date,
      status: (r.status as "draft" | "finalized") ?? "draft",
      totalPit: round2(t.pit),
      totalSsoEmployee: round2(t.ssoEmp),
      totalSsoEmployer: round2(t.ssoEmpr),
      totalNetPay: round2(t.net),
    };
  });

  return { period, runs };
}

// ---------------------------------------------------------------------
// markPitFiled/unmarkPitFiled/markSsoFiled/unmarkSsoFiled (ย้ายมาจาก payroll.ts, T137)
// ---------------------------------------------------------------------

async function hasFinalizedRun(db: DB, tenantId: string, filingPeriodId: string): Promise<boolean> {
  const { data } = await db
    .from("payroll_runs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("filing_period_id", filingPeriodId)
    .eq("status", "finalized")
    .is("deleted_at", null)
    .limit(1);
  return !!data && data.length > 0;
}

async function setFilingStatus(
  db: DB,
  tenantId: string,
  filingPeriodId: string,
  kind: "pit" | "sso",
  filed: boolean,
  actorEmployeeId: string | null
): Promise<FilingActionResult> {
  const period = await getFilingPeriodById(db, tenantId, filingPeriodId);
  if (!period) return { ok: false, message: "ไม่พบหน่วยยื่นภาษี/ประกันสังคมรายเดือนนี้ (อาจถูกลบไปแล้ว)" };

  if (filed) {
    // ★ T137 — อนุญาตเฉพาะหน่วยยื่นที่มีอย่างน้อย 1 รอบจ่าย status='finalized' ผูกอยู่ (มี JE แล้ว)
    const ok = await hasFinalizedRun(db, tenantId, filingPeriodId);
    if (!ok) {
      return {
        ok: false,
        message: "เดือนนี้ยังไม่มีรอบเงินเดือนที่สร้างรายการบัญชี (JE) แล้วเลย — บันทึกสถานะยื่นได้เฉพาะเมื่อมีอย่างน้อย 1 รอบสร้าง JE แล้ว",
      };
    }
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
  const { error } = await db.from("payroll_monthly_filings").update(payload).eq("id", filingPeriodId).eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "บันทึกสถานะไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: filingPeriodId };
}

/** บันทึกว่ายื่น ภ.ง.ด.1 แล้ว — เฉพาะหน่วยยื่นที่มีอย่างน้อย 1 รอบ finalized ผูกอยู่ (T137) */
export function markPitFiled(db: DB, tenantId: string, filingPeriodId: string, actorEmployeeId: string | null) {
  return setFilingStatus(db, tenantId, filingPeriodId, "pit", true, actorEmployeeId);
}
/** ยกเลิกสถานะยื่น ภ.ง.ด.1 (undo) */
export function unmarkPitFiled(db: DB, tenantId: string, filingPeriodId: string) {
  return setFilingStatus(db, tenantId, filingPeriodId, "pit", false, null);
}
/** บันทึกว่ายื่น สปส.1-10 แล้ว — เฉพาะหน่วยยื่นที่มีอย่างน้อย 1 รอบ finalized ผูกอยู่ (T137) */
export function markSsoFiled(db: DB, tenantId: string, filingPeriodId: string, actorEmployeeId: string | null) {
  return setFilingStatus(db, tenantId, filingPeriodId, "sso", true, actorEmployeeId);
}
/** ยกเลิกสถานะยื่น สปส.1-10 (undo) */
export function unmarkSsoFiled(db: DB, tenantId: string, filingPeriodId: string) {
  return setFilingStatus(db, tenantId, filingPeriodId, "sso", false, null);
}
