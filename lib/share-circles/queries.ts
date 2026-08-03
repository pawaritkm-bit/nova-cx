/**
 * วงแชร์ (share_circle_entries) — data layer + สูตรภาษี (ภธ.40 / ภงด.90)
 *   ใช้ในแท็บ "วงแชร์" ของหน้าลงบันทึกบัญชี (/chat-audit/accounting)
 *
 * ★ 1 แถว = 1 วง/เดือน (ไม่มีรายชื่อสมาชิก — ตามไฟล์ Excel จริงของลูกค้า)
 * ★ pure(ish): รับ SupabaseClient (service-role) + tenantId จาก session (ห้ามรับจาก client)
 * ★ กรอง deleted_at is null (soft-delete) ทุก query
 * ★ compute* เป็นฟังก์ชัน pure (รับ entries → คืนสรุป) — เทสต์ได้/คิดใหม่ทันทีหลังแก้
 * ★ PDPA: ไม่ log ชื่อวง/ตัวเลข
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

/** เพดานแถวต่อ query (กันดึงเยอะเกิน) */
const ENTRIES_LIMIT = 5000;

/** 1 วง/เดือน */
export type ShareCircleEntry = {
  id: string;
  tenantId: string;
  customerId: string;
  /** 'YYYY-MM' (ปี ค.ศ.) */
  periodMonth: string;
  /** YYYY-MM-DD หรือ null */
  entryDate: string | null;
  circleName: string;
  /** รอบเปีย (ข้อความอิสระ) */
  roundNote: string | null;
  memberCount: number | null;
  principalPerHead: number | null;
  /** (G) รายได้ท้าว */
  taoIncome: number | null;
  /** (H) ค่าบริหารจัดการ */
  mgmtFee: number | null;
  /** (I) ค่าดำเนินการ/วง */
  operationFee: number | null;
  /** (J) ดอกเบี้ยรับ */
  interestIncome: number | null;
  /** (K) ค่าใช้จ่าย/ต้นทุน */
  expense: number | null;
  /** 'ai' | 'manual' | null */
  source: string | null;
  status: string;
  createdAt: string;
};

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

/** numeric จาก DB (string) → number | null (ค่าว่าง/พัง = null) */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** ปัดทศนิยม 2 ตำแหน่ง (ยอดเงิน) */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * normalize period_month ให้เป็น "ค.ศ. YYYY-MM" เสมอ (convention เดียวทั้งระบบ)
 *   ★ ปี ≥ 2500 = พ.ศ. → ลบ 543 (2569-04 → 2026-04) · ปี ค.ศ. อยู่แล้วไม่แตะ
 *   ★ รูปแบบผิด → คืนค่าเดิม (ให้ validator ชั้นบนจัดการ)
 *   ใช้ก่อนบันทึกทุกที่ (AI worker + ผู้ใช้คีย์) กันปน พ.ศ./ค.ศ.
 */
export function normalizePeriodMonth(m: string): string {
  const mm = /^(\d{4})-(\d{2})$/.exec((m ?? "").trim());
  if (!mm) return m;
  const y = parseInt(mm[1], 10);
  return y >= 2500 ? `${y - 543}-${mm[2]}` : `${mm[1]}-${mm[2]}`;
}

type RawEntry = {
  id: string;
  tenant_id: string;
  customer_id: string;
  period_month: string;
  entry_date: string | null;
  circle_name: string;
  round_note: string | null;
  member_count: number | null;
  principal_per_head: number | string | null;
  tao_income: number | string | null;
  mgmt_fee: number | string | null;
  operation_fee: number | string | null;
  interest_income: number | string | null;
  expense: number | string | null;
  source: string | null;
  status: string;
  created_at: string;
};

function mapEntry(r: RawEntry): ShareCircleEntry {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    periodMonth: r.period_month,
    entryDate: r.entry_date,
    circleName: r.circle_name,
    roundNote: r.round_note,
    memberCount: r.member_count,
    principalPerHead: numOrNull(r.principal_per_head),
    taoIncome: numOrNull(r.tao_income),
    mgmtFee: numOrNull(r.mgmt_fee),
    operationFee: numOrNull(r.operation_fee),
    interestIncome: numOrNull(r.interest_income),
    expense: numOrNull(r.expense),
    source: r.source,
    status: r.status,
    createdAt: r.created_at,
  };
}

const SELECT_COLS =
  "id, tenant_id, customer_id, period_month, entry_date, circle_name, round_note, " +
  "member_count, principal_per_head, tao_income, mgmt_fee, operation_fee, interest_income, " +
  "expense, source, status, created_at";

// ---------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------

export type ListShareCircleArgs = {
  tenantId: string;
  customerId: string;
  /** 'YYYY-MM' — กรองเฉพาะเดือน (ไม่ใส่ = ทุกเดือน) */
  month?: string;
};

/**
 * ดึงวง/เดือน (ยังไม่ลบ) ของลูกค้า 1 ราย — เรียง period_month desc, created_at asc
 *   ★ throw error ขึ้นไปให้ผู้เรียก degrade (เช่น table ยังไม่ apply → schema cache)
 */
export async function listShareCircleEntries(
  db: DB,
  args: ListShareCircleArgs
): Promise<ShareCircleEntry[]> {
  let q = db
    .from("share_circle_entries")
    .select(SELECT_COLS)
    .eq("tenant_id", args.tenantId)
    .eq("customer_id", args.customerId)
    .is("deleted_at", null)
    .order("period_month", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(ENTRIES_LIMIT);
  if (args.month) q = q.eq("period_month", args.month);

  const { data, error } = await q;
  if (error) {
    console.warn(`[share-circles] list error code=${(error as { code?: string }).code ?? "?"}`);
    throw error;
  }
  return ((data ?? []) as unknown as RawEntry[]).map(mapEntry);
}

/**
 * ลูกค้ารายนี้ "เป็นท้าวแชร์" ไหม (มี ≥1 วง/เดือน ที่ยังไม่ลบ) — ใช้ auto-flag โชว์แท็บ
 *   ★ throw ถ้า query พัง (ให้ผู้เรียก degrade เอง เช่น table ยังไม่ apply)
 */
export async function customerHasShareCircle(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<boolean> {
  const { data, error, count } = await db
    .from("share_circle_entries")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .limit(1);
  if (error) {
    throw error;
  }
  // head:true → data เป็น null, ใช้ count
  return (count ?? (data ? (data as unknown[]).length : 0)) > 0;
}

/**
 * อ่าน flag customers.is_share_circle (สวิตช์ "ลูกค้าเป็นท้าวแชร์")
 *   ★ degrade: คอลัมน์ยังไม่ apply (schema cache) / query พัง → false เงียบ ๆ (ไม่ throw)
 */
export async function getCustomerShareCircleFlag(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("customers")
      .select("is_share_circle")
      .eq("id", customerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error || !data) return false;
    return (data as { is_share_circle?: boolean | null }).is_share_circle === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// สูตรภาษี (pure)
// ---------------------------------------------------------------------

/** สรุป ภธ.40 รายเดือน 1 เดือน */
export type SbtMonthly = {
  /** 'YYYY-MM' */
  month: string;
  /** ΣG (รายได้ท้าว) ของเดือน */
  baseG: number;
  /** ΣI (ค่าดำเนินการ/วง) ของเดือน */
  baseI: number;
  /** ฐานภาษี = ΣG + ΣI */
  base: number;
  /** SBT 3% = base × 0.03 */
  sbt3: number;
  /** ภาษีท้องถิ่น 10% = sbt3 × 0.10 */
  local: number;
  /** รวมเสียภาษี = sbt3 × 1.1 = base × 3.3% */
  total: number;
  /** จำนวนวงในเดือนนี้ */
  circleCount: number;
};

/**
 * คิด ภธ.40 (ภาษีธุรกิจเฉพาะ) รายเดือน จาก entries — จัดกลุ่มตาม period_month
 *   ฐาน = (ΣG + ΣI) · SBT = ฐาน×3% · ท้องถิ่น = SBT×10% · รวม = SBT×1.1 (= ฐาน×3.3%)
 *   ★ เรียงเดือนใหม่→เก่า
 */
export function computeSbtMonthly(entries: ShareCircleEntry[]): SbtMonthly[] {
  const byMonth = new Map<string, { g: number; i: number; count: number }>();
  for (const e of entries) {
    const cur = byMonth.get(e.periodMonth) ?? { g: 0, i: 0, count: 0 };
    cur.g = round2(cur.g + (e.taoIncome ?? 0));
    cur.i = round2(cur.i + (e.operationFee ?? 0));
    cur.count += 1;
    byMonth.set(e.periodMonth, cur);
  }
  const rows: SbtMonthly[] = [];
  for (const [month, v] of byMonth) {
    const base = round2(v.g + v.i);
    const sbt3 = round2(base * 0.03);
    const local = round2(sbt3 * 0.1);
    const total = round2(sbt3 * 1.1);
    rows.push({ month, baseG: v.g, baseI: v.i, base, sbt3, local, total, circleCount: v.count });
  }
  return rows.sort((a, b) => b.month.localeCompare(a.month));
}

/** สรุป ภงด.90 ปลายปี 1 ปี */
export type YearSummary = {
  /** ปี ค.ศ. เช่น '2026' */
  year: string;
  /** รายได้ธุรกิจที่ได้สิทธิหักเหมา = Σ(G+H+I) */
  businessIncome: number;
  /** ดอกเบี้ยรับ ม.40(4) ΣJ — ★ ไม่ได้สิทธิหักเหมา 60/40 */
  interestIncome: number;
  /** รายได้รวมทั้งปี (businessIncome + interestIncome) */
  totalIncome: number;
  /** businessIncome × 0.4 (หลังหักค่าใช้จ่ายเหมา 60/40) */
  businessAfterFlat: number;
  /** ยอดประเมินหลังหักเหมา = businessIncome×0.4 + ดอกเบี้ยเต็ม (J ไม่หักเหมา) */
  afterDeduction: number;
};

/**
 * คิดยอด ภงด.90 ปลายปี (Phase 1: ตัวประเมิน) — จัดกลุ่มตามปี
 *   ★ หลักภาษี: รายได้ธุรกิจวงแชร์ (G+H+I) เป็นเงินได้ที่หักค่าใช้จ่ายเหมา 60/40 ได้ (เหลือ 40%)
 *     แต่ "ดอกเบี้ยรับ (J)" เป็นเงินได้ ม.40(4) ★ไม่ได้สิทธิหักเหมา★ → บวกเต็มทีหลัง
 *   afterDeduction = (G+H+I)×0.4 + J
 *   ★ เป็นตัวประเมินเบื้องต้น — ลดหย่อน/ภาษีขั้นบันได ให้นักบัญชีคิดต่อเอง (ไม่เดา)
 *   ★ เรียงปีใหม่→เก่า
 */
export function computeYearSummary(entries: ShareCircleEntry[]): YearSummary[] {
  const byYear = new Map<string, { business: number; interest: number }>();
  for (const e of entries) {
    const year = (e.periodMonth || "").slice(0, 4);
    if (!/^\d{4}$/.test(year)) continue;
    const cur = byYear.get(year) ?? { business: 0, interest: 0 };
    cur.business = round2(cur.business + (e.taoIncome ?? 0) + (e.mgmtFee ?? 0) + (e.operationFee ?? 0));
    cur.interest = round2(cur.interest + (e.interestIncome ?? 0));
    byYear.set(year, cur);
  }
  const rows: YearSummary[] = [];
  for (const [year, v] of byYear) {
    const businessAfterFlat = round2(v.business * 0.4);
    rows.push({
      year,
      businessIncome: v.business,
      interestIncome: v.interest,
      totalIncome: round2(v.business + v.interest),
      businessAfterFlat,
      afterDeduction: round2(businessAfterFlat + v.interest),
    });
  }
  return rows.sort((a, b) => b.year.localeCompare(a.year));
}
