/**
 * รายงานประเมินนักบัญชีรายเดือน (รายบุคคล) — Phase 5b
 *   รวม conversation_cases (SLA/ปิดงาน) + accountant_evaluations (คะแนน 8 มิติ)
 *   + coaching_recommendations (จุดแข็ง/ควรปรับ/ปัญหาซ้ำ/แผน) → 1 รายงานต่อ (พนักงาน+เดือน)
 *
 * ★ กติกาสิทธิ์ (tier — reuse lib/evaluation/access):
 *     - executive/admin/auditor_qa : ดูได้ทุกคน (ทุกสถานะ eval)
 *     - acc_lead                   : ดูได้เฉพาะทีมตัวเอง (owner ∈ teamMemberIds) หรือของตัวเอง
 *     - hr                         : ดูได้ทุกคน "แต่คะแนนนับเฉพาะ eval ที่ confirmed" เท่านั้น
 *     - accountant                 : เฉพาะของตัวเอง
 *     - อื่น/null                   : ปฏิเสธ (default deny)
 *   → บังคับที่ app-layer (ฟังก์ชันนี้) ก่อนอ่านด้วย service-role
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONFIRMED_STATUSES,
  isTeamLeadOf,
  type Viewer,
} from "@/lib/evaluation/access";
import { EVAL_DIMENSIONS } from "@/lib/chat-dashboard/evaluation-detail";

type DB = SupabaseClient;

// ---------------------------------------------------------------------
// Tier: ตัดสินสิทธิ์อ่านรายงานของ employee + สถานะ eval ที่ "นับคะแนนได้"
// ---------------------------------------------------------------------
export type ReportAccess =
  | { allowed: false }
  /** confirmedOnly=true → นับคะแนนเฉพาะ eval ที่หัวหน้ายืนยันแล้ว (hr) */
  | { allowed: true; confirmedOnly: boolean };

/**
 * ตัดสินว่า viewer เปิดรายงานของ targetEmployeeId ได้ไหม + คะแนนนับสถานะไหน
 *   ★ default deny — role null/ไม่รู้จัก = ปฏิเสธ
 */
export function resolveReportAccess(
  viewer: Viewer,
  targetEmployeeId: string
): ReportAccess {
  const role = viewer.role;
  if (!role) return { allowed: false };
  if (role === "admin" || role === "executive" || role === "auditor_qa") {
    return { allowed: true, confirmedOnly: false };
  }
  if (role === "hr") {
    // hr เห็นได้ทุกคน แต่ "คะแนน" นับเฉพาะ eval ที่ confirmed เท่านั้น
    return { allowed: true, confirmedOnly: true };
  }
  if (role === "acc_lead") {
    if (isTeamLeadOf(viewer, targetEmployeeId)) return { allowed: true, confirmedOnly: false };
    if (viewer.employeeId && viewer.employeeId === targetEmployeeId) {
      return { allowed: true, confirmedOnly: false };
    }
    return { allowed: false };
  }
  // accountant/อื่น ๆ: เฉพาะของตัวเอง
  if (viewer.employeeId && viewer.employeeId === targetEmployeeId) {
    return { allowed: true, confirmedOnly: false };
  }
  return { allowed: false };
}

// ---------------------------------------------------------------------
// ตัวช่วยเชิงเวลา/ช่วงเดือน (period = 'YYYY-MM')
// ---------------------------------------------------------------------
/** true = 'YYYY-MM' ที่ถูกต้อง (เดือน 01-12) */
export function isValidPeriod(p: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(p)) return false;
  const month = Number(p.slice(5, 7));
  return month >= 1 && month <= 12;
}

/** ช่วง [start, end) ของเดือน (ISO) จาก 'YYYY-MM' — end = ต้นเดือนถัดไป (exclusive) */
export function monthRange(period: string): { start: string; end: string } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7)); // 1-12
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/** เดือนก่อนหน้าในรูป 'YYYY-MM' */
export function previousPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const d = new Date(Date.UTC(year, month - 2, 1)); // month-1 (0-based) แล้วถอย 1 = month-2
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------
// สรุปเคส (pure) — คำนวณ KPI จากแถว conversation_cases
// ---------------------------------------------------------------------
export type CaseRow = {
  id: string;
  customer_id: string | null;
  status: string;
  opened_at: string;
  first_responded_at: string | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  closed_at: string | null;
};

export type CaseSummary = {
  customerCount: number;
  totalCases: number;
  closedCases: number;
  closedPct: number | null;
  avgFirstResponseMin: number | null;
  avgResolutionMin: number | null;
  overSlaCases: number;
  reopenedCases: number;
};

const CLOSED_STATUSES = new Set(["resolved", "closed"]);

function diffMinutes(fromISO: string, toISO: string): number | null {
  const a = new Date(fromISO).getTime();
  const b = new Date(toISO).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 60000;
}

/**
 * สรุป KPI จาก cases (นับ over-SLA จากการเลยกำหนดจริง)
 *   ★ now = เวลาอ้างอิงคงที่ (freeze ณ จุดสร้างรายงาน) เพื่อให้รายงานที่มีช่องเซ็นอนุมัติ
 *     reproducible — เคส open ที่เลยกำหนดปิดวัดเทียบ now ค่าเดียว (ไม่ใช่ Date.now กระจาย)
 */
export function summarizeCases(cases: CaseRow[], now: number = Date.now()): CaseSummary {
  const customers = new Set<string>();
  let closed = 0;
  let overSla = 0;
  let reopened = 0;
  const frMins: number[] = [];
  const resMins: number[] = [];

  for (const c of cases) {
    if (c.customer_id) customers.add(c.customer_id);
    if (CLOSED_STATUSES.has(c.status)) closed++;
    if (c.status === "reopened") reopened++;

    // เวลาตอบครั้งแรก
    if (c.first_responded_at) {
      const m = diffMinutes(c.opened_at, c.first_responded_at);
      if (m !== null) frMins.push(m);
    }
    // เวลาปิดเคส
    if (c.closed_at) {
      const m = diffMinutes(c.opened_at, c.closed_at);
      if (m !== null) resMins.push(m);
    }

    // เกิน SLA: ตอบครั้งแรกช้ากว่ากำหนด หรือ ปิดช้ากว่ากำหนด
    const frLate =
      c.first_response_due_at &&
      c.first_responded_at &&
      new Date(c.first_responded_at).getTime() > new Date(c.first_response_due_at).getTime();
    const resLate =
      c.resolution_due_at &&
      c.closed_at &&
      new Date(c.closed_at).getTime() > new Date(c.resolution_due_at).getTime();
    // ยังไม่ปิดแต่เลยกำหนดปิดแล้ว = เกิน SLA เช่นกัน
    const resOverdueOpen =
      c.resolution_due_at &&
      !c.closed_at &&
      now > new Date(c.resolution_due_at).getTime();
    if (frLate || resLate || resOverdueOpen) overSla++;
  }

  const avg = (arr: number[]): number | null =>
    arr.length === 0 ? null : Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;

  return {
    customerCount: customers.size,
    totalCases: cases.length,
    closedCases: closed,
    closedPct: cases.length === 0 ? null : Math.round((closed / cases.length) * 100),
    avgFirstResponseMin: avg(frMins),
    avgResolutionMin: avg(resMins),
    overSlaCases: overSla,
    reopenedCases: reopened,
  };
}

// ---------------------------------------------------------------------
// เฉลี่ยคะแนน 8 มิติ + overall จากชุด eval (pure)
// ---------------------------------------------------------------------
export type EvalRow = {
  status: string;
  overall_score: number | null;
  dimension_scores: Record<string, unknown> | null;
};

export type DimensionAvg = { key: string; label: string; avg: number | null };

export type ScoreSummary = {
  overallAvg: number | null;
  evalCount: number;
  dimensions: DimensionAvg[];
};

function toNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** เฉลี่ยคะแนน (นับเฉพาะ eval ใน rows ที่ผ่าน filter สถานะแล้ว) */
export function summarizeScores(rows: EvalRow[]): ScoreSummary {
  const overalls: number[] = [];
  const dimAcc: Record<string, number[]> = {};
  for (const r of rows) {
    const o = toNum(r.overall_score);
    if (o !== null) overalls.push(o);
    const dims = r.dimension_scores ?? {};
    for (const d of EVAL_DIMENSIONS) {
      const val = toNum((dims as Record<string, unknown>)[d.key]);
      if (val !== null) {
        (dimAcc[d.key] ??= []).push(val);
      }
    }
  }
  const avg = (arr: number[] | undefined): number | null =>
    !arr || arr.length === 0 ? null : Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;

  return {
    overallAvg: avg(overalls),
    evalCount: rows.length,
    dimensions: EVAL_DIMENSIONS.map((d) => ({
      key: d.key,
      label: d.label,
      avg: avg(dimAcc[d.key]),
    })),
  };
}

// ---------------------------------------------------------------------
// รายงานฉบับเต็ม (โหลด DB + ประกอบ)
// ---------------------------------------------------------------------
export type MonthlyReport = {
  employeeId: string;
  employeeName: string;
  period: string;
  confirmedOnly: boolean;
  cases: CaseSummary;
  scores: ScoreSummary;
  strengths: string[];
  improvements: string[];
  repeatedErrors: string[];
  trainingTopics: string[];
  nextPlan: string[];
  /** เทียบเดือนก่อน (overall + เวลาตอบ + เกิน SLA) */
  compare: {
    prevPeriod: string;
    prevOverall: number | null;
    prevAvgFirstResponseMin: number | null;
    prevOverSlaCases: number | null;
  };
};

export class ReportAccessError extends Error {
  constructor(message = "คุณไม่มีสิทธิ์ดูรายงานของพนักงานคนนี้") {
    super(message);
    this.name = "ReportAccessError";
  }
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) =>
      typeof x === "string"
        ? x
        : x && typeof x === "object"
          ? String((x as Record<string, unknown>).text ?? (x as Record<string, unknown>).note ?? "")
          : ""
    )
    .filter((s) => s.trim().length > 0);
}

/** โยน error ถ้า query ล้ม — ไม่ปล่อยให้กลืน error แล้วได้ [] เงียบ (รายงานศูนย์ทั้งใบ) */
function throwIfDbError(error: unknown, context: string): void {
  if (error) {
    throw new Error(`อ่านข้อมูลรายงานไม่สำเร็จ (${context})`);
  }
}

/** โหลด cases + evals ของ employee ในช่วงเดือน (scope tenant + สถานะตาม tier) */
async function loadCaseAndEval(
  db: DB,
  tenantId: string,
  employeeId: string,
  period: string,
  confirmedOnly: boolean
): Promise<{ cases: CaseRow[]; evals: EvalRow[] }> {
  const { start, end } = monthRange(period);

  const { data: caseData, error: caseErr } = await db
    .from("conversation_cases")
    .select(
      "id, customer_id, status, opened_at, first_responded_at, first_response_due_at, resolution_due_at, closed_at"
    )
    .eq("tenant_id", tenantId)
    .eq("owner_employee_id", employeeId)
    .is("deleted_at", null)
    .gte("opened_at", start)
    .lt("opened_at", end);
  throwIfDbError(caseErr, "conversation_cases");

  let evalQuery = db
    .from("accountant_evaluations")
    .select("status, overall_score, dimension_scores, period_start")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .is("deleted_at", null)
    .gte("period_start", start)
    .lt("period_start", end);
  if (confirmedOnly) {
    evalQuery = evalQuery.in("status", [...CONFIRMED_STATUSES]);
  }
  const { data: evalData, error: evalErr } = await evalQuery;
  throwIfDbError(evalErr, "accountant_evaluations");

  return {
    cases: (caseData ?? []) as CaseRow[],
    evals: (evalData ?? []) as EvalRow[],
  };
}

/**
 * สร้างรายงานประเมินรายเดือนของนักบัญชี 1 คน
 *   - guard tier ก่อน (resolveReportAccess) — ปฏิเสธ = throw ReportAccessError
 *   - อ่านด้วย service-role (bypass RLS) แต่ scope tenant จาก session + สถานะตาม tier
 */
export async function buildMonthlyReport(
  db: DB,
  viewer: Viewer,
  args: { employeeId: string; period: string }
): Promise<MonthlyReport> {
  const tenantId = viewer.tenantId;
  if (!tenantId) throw new ReportAccessError();

  const access = resolveReportAccess(viewer, args.employeeId);
  if (!access.allowed) throw new ReportAccessError();

  // ยืนยันว่าพนักงานอยู่ใน tenant นี้จริง + ดึงชื่อ
  //   ★ แยก "DB error จริง" (throw generic) ออกจาก "ไม่พบพนักงาน" (ReportAccessError)
  const { data: empData, error: empErr } = await db
    .from("employees")
    .select("id, first_name, nickname")
    .eq("id", args.employeeId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  throwIfDbError(empErr, "employees");
  const emp = empData as { first_name?: string; nickname?: string | null } | null;
  if (!emp) throw new ReportAccessError("ไม่พบพนักงานที่เลือก");
  const employeeName = emp.nickname || emp.first_name || args.employeeId;

  // ★ freeze เวลา 1 ค่า ณ จุดสร้างรายงาน (reproducible + ส่งต่อ summarizeCases ทุกที่)
  const now = Date.now();

  const { cases, evals } = await loadCaseAndEval(
    db,
    tenantId,
    args.employeeId,
    args.period,
    access.confirmedOnly
  );

  // ★ [High] coaching = evidence — RLS can_view_eval_evidence (0035) ตัด hr ออก
  //   รายงาน/export ต้อง mirror: hr (confirmedOnly) เห็นแค่ "คะแนน" ไม่เห็น coaching
  //   → ข้าม query coaching + คืนรายการว่างทั้งหมด
  let coach:
    | {
        strengths?: unknown;
        improvements?: unknown;
        repeated_errors?: unknown;
        training_topics?: unknown;
        checklist?: unknown;
      }
    | undefined;
  if (!access.confirmedOnly) {
    const { start, end } = monthRange(args.period);
    const { data: coachData, error: coachErr } = await db
      .from("coaching_recommendations")
      .select("strengths, improvements, repeated_errors, training_topics, checklist, created_at")
      .eq("tenant_id", tenantId)
      .eq("employee_id", args.employeeId)
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false })
      .limit(1);
    throwIfDbError(coachErr, "coaching_recommendations");
    coach = (coachData ?? [])[0] as typeof coach;
  }

  // เทียบเดือนก่อน (overall + เวลาตอบ + เกิน SLA)
  const prevPeriod = previousPeriod(args.period);
  const prev = await loadCaseAndEval(
    db,
    tenantId,
    args.employeeId,
    prevPeriod,
    access.confirmedOnly
  );
  const prevCases = summarizeCases(prev.cases, now);
  const prevScores = summarizeScores(prev.evals);

  return {
    employeeId: args.employeeId,
    employeeName,
    period: args.period,
    confirmedOnly: access.confirmedOnly,
    cases: summarizeCases(cases, now),
    scores: summarizeScores(evals),
    strengths: strList(coach?.strengths),
    improvements: strList(coach?.improvements),
    repeatedErrors: strList(coach?.repeated_errors),
    trainingTopics: strList(coach?.training_topics),
    nextPlan: strList(coach?.checklist),
    compare: {
      prevPeriod,
      prevOverall: prevScores.overallAvg,
      prevAvgFirstResponseMin: prevCases.avgFirstResponseMin,
      prevOverSlaCases: prev.cases.length > 0 ? prevCases.overSlaCases : null,
    },
  };
}

// ---------------------------------------------------------------------
// แปลงรายงาน → worksheet สำหรับ export .xlsx
// ---------------------------------------------------------------------
import type { XlsxSheet } from "./xlsx";

/** แปลง MonthlyReport เป็น sheet เดียว (หัวข้อ + KPI + คะแนนแยกด้าน + coaching) */
export function reportToSheet(r: MonthlyReport): XlsxSheet {
  const rows: (string | number | null)[][] = [];
  rows.push(["รายงานประเมินผลงาน (รายเดือน)"]);
  rows.push(["พนักงาน", r.employeeName]);
  rows.push(["รอบเดือน", r.period]);
  if (r.confirmedOnly) rows.push(["หมายเหตุ", "คะแนนนับเฉพาะผลที่หัวหน้ายืนยันแล้ว"]);
  rows.push([]);

  rows.push(["ตัวชี้วัด", "ค่า"]);
  rows.push(["ลูกค้าที่ดูแล", r.cases.customerCount]);
  rows.push(["เคสทั้งหมด", r.cases.totalCases]);
  rows.push(["ปิดสำเร็จ", r.cases.closedCases]);
  rows.push(["อัตราปิดสำเร็จ (%)", r.cases.closedPct ?? "—"]);
  rows.push(["เวลาตอบครั้งแรกเฉลี่ย (นาที)", r.cases.avgFirstResponseMin ?? "—"]);
  rows.push(["เวลาปิดเคสเฉลี่ย (นาที)", r.cases.avgResolutionMin ?? "—"]);
  rows.push(["เกิน SLA (เคส)", r.cases.overSlaCases]);
  rows.push(["ทวงซ้ำ/เปิดใหม่ (เคส)", r.cases.reopenedCases]);
  rows.push(["คะแนนรวมเฉลี่ย", r.scores.overallAvg ?? "—"]);
  rows.push([]);

  rows.push(["คะแนนแยก 8 มิติ", "เฉลี่ย (0-100)"]);
  for (const d of r.scores.dimensions) {
    rows.push([d.label, d.avg ?? "—"]);
  }
  rows.push([]);

  rows.push(["เทียบเดือนก่อน", r.compare.prevPeriod]);
  rows.push(["คะแนนรวม (เดือนก่อน)", r.compare.prevOverall ?? "—"]);
  rows.push(["เวลาตอบเฉลี่ย (เดือนก่อน)", r.compare.prevAvgFirstResponseMin ?? "—"]);
  rows.push(["เกิน SLA (เดือนก่อน)", r.compare.prevOverSlaCases ?? "—"]);
  rows.push([]);

  const listSection = (title: string, items: string[]) => {
    rows.push([title]);
    if (items.length === 0) rows.push(["—"]);
    for (const it of items) rows.push([it]);
    rows.push([]);
  };
  listSection("จุดแข็ง", r.strengths);
  listSection("จุดที่ควรปรับ", r.improvements);
  listSection("ปัญหาซ้ำ", r.repeatedErrors);
  listSection("แผนพัฒนาเดือนหน้า", r.nextPlan);

  return { name: `รายงาน ${r.period}`, rows };
}
