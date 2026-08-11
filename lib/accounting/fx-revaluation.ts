/**
 * ปรับปรุงอัตราแลกเปลี่ยนปลายงวด (Unrealized FX Revaluation) + auto-reversing เต็มรูป — data layer (DB) +
 *   pure mapper ในไฟล์เดียว (mirror bill-payments.ts/credit-debit-notes.ts)
 *
 * บริบท: เฟส 10b (docs/06-accounting-features-roadmap.md บรรทัด 5485-6084) — ต่อจากเฟส 10a ที่บันทึกบิล/
 *   รับ-จ่ายเงิน/CN-DN สกุลต่างประเทศได้แล้ว แต่ยังไม่มีกลไก "ปรับปรุงยอดคงค้าง FX ปลายงวดตามอัตราปิด" เลย
 *   (ย่อหน้า 29 ของ TAS 21) — เฟสนี้เติมส่วนนั้นด้วยกลไก "reversing entry ต้นงวดถัดไป" (0.1/0.2/0.9)
 *
 * ★★ 0.2 — สูตรหลัก: unrealizedFxGainLoss reuse `fx.ts::realizedFxGainLoss` ตรง ๆ (แทน settleFxRate ด้วย
 *   closingRate) — ไม่มีสูตรคู่ขนาน · engine เดิมของเฟส 10a (`fx.ts`) ไม่ถูกแก้เลยแม้แต่บรรทัดเดียว
 * ★★ 0.12 — guard ทุกจุด (assertNoPendingCycle/assertReversalConfirmedForPayment) ต้องเช็ค **live status
 *   ของ manual_journal_entries จริงเสมอ** ผ่าน deriveLiveRevaluationStatus — ไม่เชื่อคอลัมน์ `status` ที่
 *   cache ไว้ตรง ๆ (คอลัมน์นั้นใช้แค่ list/แสดงผลเร็ว)
 * ★ never-auto-confirm เสมอ (0.1/0.9) — createFxRevaluationDraft/confirmFxRevaluation/confirmFxReversing
 *   สร้าง manual JE เป็น draft เสมอ ผ่าน upsertManualEntry/confirmManualEntry เดิม (ไม่แก้ตรรกะภายใน)
 * ★ ไม่แก้ bill_entries.fx_rate เลย (เข้ากันได้กับ 0.9 เฟส 10a ที่ล็อก currency/fx_rate ตลอดชีวิตบิลหลังมี
 *   bill_payments ผูกแล้ว) — ใช้ closing_rate แยกเก็บที่ตาราง fx_period_revaluations เท่านั้น
 * ★ PDPA: ไม่ log ตัวเลข/อัตราแลกเปลี่ยน/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildChartByCode, type ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { round2, listEntries } from "@/lib/accounting/queries";
import { isCreditEligibleForPayment, listBillPaymentsForEntries } from "@/lib/accounting/bill-payments";
import { listNotesForEntries, netFxAdjustmentByEntry } from "@/lib/accounting/credit-debit-notes";
import { realizedFxGainLoss, type FxEligibleEntryType } from "@/lib/accounting/fx";
import { isValidCurrencyCode, validateFxRate, DEFAULT_FX_GAIN_LOSS_ACCOUNT_CODE } from "@/lib/accounting/currency";
import { AR, AP, EPSILON } from "@/lib/accounting/statement-config";
import {
  upsertManualEntry,
  confirmManualEntry,
  unconfirmManualEntry,
  softDeleteManualEntry,
  type ManualEntryInput,
  type ManualJournalLine,
} from "@/lib/accounting/manual-journal";

type DB = SupabaseClient;

const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function numLocal(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function nonZero(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) >= EPSILON;
}

// ---------------------------------------------------------------------
// pure — วันที่ (จัดการข้ามเดือน/ข้ามปีถูกต้อง — Date.UTC เที่ยงคืน UTC กัน timezone shift)
// ---------------------------------------------------------------------

/** วันแรกของ "งวดถัดไป" = period_end_date + 1 วัน (0.6/0.9) — รองรับข้ามเดือน/ข้ามปี */
export function nextPeriodStartDate(periodEndDateIso: string): string {
  const m = DATE_RE.exec(periodEndDateIso);
  if (!m) return periodEndDateIso; // defensive — ไม่ควรเกิดจาก flow จริง (validate ก่อนเรียกเสมอ)
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** จำนวนวันของ a เทียบ b (a - b, วัน) — string ISO 'YYYY-MM-DD' ทั้งคู่ (ใช้กับ badge เตือนค้างยืนยัน 0.18) */
function daysBetweenIso(a: string, b: string): number {
  const ma = DATE_RE.exec(a);
  const mb = DATE_RE.exec(b);
  if (!ma || !mb) return 0;
  const da = Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]));
  const db = Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]));
  return Math.round((db - da) / (24 * 60 * 60 * 1000));
}

/** วันนี้ตามเวลาไทย 'YYYY-MM-DD' (mirror todayThai ของ payments/page.tsx — ไม่พึ่ง server timezone) */
function todayThaiIso(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const mo = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${mo}-${d}`;
}

// ---------------------------------------------------------------------
// pure — engine หลัก (0.2/0.4)
// ---------------------------------------------------------------------

/**
 * ยอดคงค้างสกุลต่างประเทศ (ก่อน VAT) ของบิล 1 ใบ ณ วันที่ระบุ (0.4) —
 *   = Σ(bill_entry_lines.fx_amount ก่อน VAT) − Σ(bill_payments.fx_amount ที่ยังไม่ยกเลิก และ payDate ≤
 *     asOfDate) + fxNoteAdjustment (สัญญาณจาก CN/DN confirmed ที่มี fx_amount ของบิลนั้น)
 *   @param asOfDate optional — ไม่ส่ง = ไม่กรอง payments ด้วย payDate (ใช้เมื่อ caller กรอง/รวมยอดมาก่อน
 *     แล้วแล้ว เช่นผ่าน listBillPaymentsForEntries(..., asOfDate) ที่กรองที่ query จริงมาแล้ว)
 */
export function outstandingFxForEntry(
  fxLinesTotal: number,
  fxPayments: { fxAmount: number; payDate: string }[],
  fxNoteAdjustment = 0,
  asOfDate?: string
): number {
  const eligible = asOfDate ? fxPayments.filter((p) => p.payDate <= asOfDate) : fxPayments;
  const paid = round2(eligible.reduce((s, p) => s + numLocal(p.fxAmount), 0));
  return round2(numLocal(fxLinesTotal) + numLocal(fxNoteAdjustment) - paid);
}

/**
 * กำไร/ขาดทุนจากอัตราแลกเปลี่ยนที่ "ยังไม่รับรู้" (unrealized) ปลายงวด — reuse `fx.ts::realizedFxGainLoss`
 *   ตรง ๆ (0.2, ไม่มีสูตรคู่ขนาน) เพียงแค่ import แล้ว re-export ชื่อใหม่เพื่อความชัดเจนของ caller:
 *   แทน `settleFxRate` (อัตราวันชำระ) ด้วย `closingRate` (อัตราปิดปลายงวด)
 */
export const unrealizedFxGainLoss = realizedFxGainLoss;

/** breakdown รายบิล 1 ใบ ที่ประกอบเป็นยอดรวมของกลุ่ม (T134 — ต้องโชว์ก่อนยืนยันเสมอ ดูหมวด 5 ของแผน) */
export type FxOutstandingBillBreakdown = {
  entryId: string;
  docNo: string | null;
  docDate: string | null;
  counterpartyName: string | null;
  /** อัตรา "ตอนออกบิล" ของบิลใบนี้ (bill_entries.fx_rate) — แต่ละบิลในกลุ่มเดียวกันอาจต่างกันได้ (หมวด 5) */
  invoiceFxRate: number;
  outstandingFxAmount: number;
};

/** ยอดคงค้าง FX รวมของ 1 กลุ่ม (customer+currency+entryType) พร้อม breakdown รายบิล */
export type FxOutstandingGroup = {
  customerId: string;
  entryType: FxEligibleEntryType;
  currency: string;
  /** รวมยอดคงค้างของทุกบิลในกลุ่ม (ปัดเศษครั้งเดียวตอนสุดท้าย — ไม่ปัดเศษรายบิลแล้วบวกกัน ดูหมวด 5) */
  outstandingFxAmount: number;
  bills: FxOutstandingBillBreakdown[];
};

/**
 * รวมยอด unrealized ของทั้งกลุ่ม จาก breakdown รายบิล (หมวด 5 — ความเสี่ยง "รวมยอดหลายบิลเป็น JV เดียว"):
 *   บิลแต่ละใบในกลุ่มเดียวกัน (customer+currency+entryType) อาจมี invoiceFxRate ต่างกัน (bill_entries.fx_rate
 *   ล็อกไว้ตลอดชีวิตบิลตาม 0.9 เฟส 10a) — ต้องคำนวณ unrealized "ต่อบิล" ด้วย closingRate เดียวกัน แล้วรวม
 *   ผลลัพธ์ (ไม่ใช่เอายอดรวม outstandingFxAmount ไปคูณ closingRate ตรง ๆ ซึ่งจะผิดถ้า invoiceFxRate ต่างกัน)
 *   — ปัดเศษครั้งเดียวตอนสุดท้าย
 */
export function computeGroupUnrealizedAmount(
  bills: Pick<FxOutstandingBillBreakdown, "outstandingFxAmount" | "invoiceFxRate">[],
  entryType: FxEligibleEntryType,
  closingRate: number
): number {
  let sum = 0;
  for (const b of bills) {
    sum += unrealizedFxGainLoss(entryType, b.outstandingFxAmount, b.invoiceFxRate, closingRate);
  }
  return round2(sum);
}

/** metadata FX ล้วน (badge) ที่ติดกับทุกบรรทัดของ JV ปรับปรุง — mirror fx.ts::suggestFxGainLossEntryInput */
export type FxRevaluationMeta = { currency: string; closingRate: number; outstandingFxAmount: number };

/**
 * ประกอบ ManualEntryInput (draft) สำหรับ JV ปรับปรุงอัตราแลกเปลี่ยนปลายงวด (0.7 ของไฟล์นี้ — กติกาเดียว
 *   ทิศทางเดียวกันทั้ง sale/purchase, ไม่ขึ้นกับ entryType):
 *   - unrealizedAmount > 0 → Dr AR/AP-code · Cr gainLossAccount
 *   - unrealizedAmount < 0 → Dr gainLossAccount · Cr AR/AP-code (ขนาด |amount|)
 *   @returns `null` เมื่อ unrealizedAmount = 0 (ไม่มีความหมายให้สร้าง JV เปล่า — mirror T90 เฟส 10a)
 *   accountName ไม่ระบุ (ให้ validateManualEntryInput เติมจาก chartByCode ตอน upsertManualEntry — เหมือน
 *   pattern อื่นทั้งระบบที่ไม่ query ชื่อบัญชีซ้ำในไฟล์ pure)
 */
export function buildRevaluationEntryInput(
  entryType: FxEligibleEntryType,
  unrealizedAmount: number,
  arApAccountCode: string,
  gainLossAccountCode: string,
  docDate: string,
  memo: string,
  fxMeta?: FxRevaluationMeta
): ManualEntryInput | null {
  void entryType; // ทิศทางขึ้นกับเครื่องหมายของ unrealizedAmount เท่านั้น ไม่ขึ้นกับ sale/purchase (0.7)
  const amount = round2(Math.abs(unrealizedAmount));
  if (!nonZero(amount)) return null;

  const meta = fxMeta
    ? { fxCurrency: fxMeta.currency, fxRate: fxMeta.closingRate, fxAmount: fxMeta.outstandingFxAmount }
    : {};
  const isArApDebit = unrealizedAmount > 0;
  const lines = isArApDebit
    ? [
        { accountCode: arApAccountCode, debit: amount, credit: 0, ...meta },
        { accountCode: gainLossAccountCode, debit: 0, credit: amount, ...meta },
      ]
    : [
        { accountCode: gainLossAccountCode, debit: amount, credit: 0, ...meta },
        { accountCode: arApAccountCode, debit: 0, credit: amount, ...meta },
      ];

  return { docType: "JV", docDate, docNo: null, memo, lines };
}

/**
 * ประกอบ ManualEntryInput (draft) สำหรับ JV กลับรายการ (reversing) — สลับ debit↔credit ของทุกบรรทัดจาก JV
 *   ปรับปรุงต้นฉบับเป๊ะ (0.9 — ไม่คำนวณใหม่ กันความคลาดเคลื่อนจากการปัดเศษ/ดึงอัตราใหม่โดยไม่ตั้งใจ)
 */
export function buildReversingEntryInput(
  revalLines: Pick<ManualJournalLine, "accountCode" | "accountName" | "description" | "debit" | "credit" | "fxCurrency" | "fxRate" | "fxAmount">[],
  nextPeriodStart: string,
  memo: string
): ManualEntryInput {
  const lines = revalLines.map((l) => ({
    accountCode: l.accountCode,
    accountName: l.accountName,
    description: l.description,
    debit: l.credit,
    credit: l.debit,
    fxCurrency: l.fxCurrency,
    fxRate: l.fxRate,
    fxAmount: l.fxAmount,
  }));
  return { docType: "JV", docDate: nextPeriodStart, docNo: null, memo, lines };
}

// ---------------------------------------------------------------------
// data layer (DB) — ทุก query/write กรอง tenant_id เสมอ
// ---------------------------------------------------------------------

const LIST_LIMIT = 500;
/** เพดานประวัติ cycle ต่อกลุ่มที่ไล่หา "ล่าสุดที่ยัง live-active" (0.10/0.11) — พอเกินความจำเป็นจริงมาก */
const CYCLE_HISTORY_LIMIT = 60;

export type FxPeriodRevaluationStatus = "reval_draft" | "reversing_draft" | "reversing_confirmed" | "voided";

export type FxPeriodRevaluation = {
  id: string;
  tenantId: string;
  customerId: string;
  entryType: FxEligibleEntryType;
  currency: string;
  periodEndDate: string;
  closingRate: number;
  source: "bot" | "manual";
  outstandingFxAmount: number;
  unrealizedAmount: number;
  revaluationJeId: string | null;
  reversingJeId: string | null;
  /** cache สำหรับ list/แสดงผลเร็วเท่านั้น — ห้าม guard เชื่อค่านี้ตรง ๆ (0.12) */
  status: FxPeriodRevaluationStatus;
  createdAt: string;
};

type RawFxRevalRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  entry_type: string;
  currency: string;
  period_end_date: string;
  closing_rate: number | string;
  source: string;
  outstanding_fx_amount: number | string;
  unrealized_amount: number | string;
  revaluation_je_id: string | null;
  reversing_je_id: string | null;
  status: string;
  created_at: string;
};

const FX_REVAL_COLUMNS =
  "id, tenant_id, customer_id, entry_type, currency, period_end_date, closing_rate, source, outstanding_fx_amount, unrealized_amount, revaluation_je_id, reversing_je_id, status, created_at";

function asFxEntryType(v: string): FxEligibleEntryType {
  return v === "purchase" ? "purchase" : "sale";
}

function asFxStatus(v: string): FxPeriodRevaluationStatus {
  return v === "reversing_draft" || v === "reversing_confirmed" || v === "voided" ? v : "reval_draft";
}

function mapFxRevalRow(r: RawFxRevalRow): FxPeriodRevaluation {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    entryType: asFxEntryType(r.entry_type),
    currency: r.currency,
    periodEndDate: r.period_end_date,
    closingRate: numLocal(r.closing_rate),
    source: r.source === "bot" ? "bot" : "manual",
    outstandingFxAmount: numLocal(r.outstanding_fx_amount),
    unrealizedAmount: numLocal(r.unrealized_amount),
    revaluationJeId: r.revaluation_je_id,
    reversingJeId: r.reversing_je_id,
    status: asFxStatus(r.status),
    createdAt: r.created_at,
  };
}

/**
 * โหลดยอดคงค้าง FX รวมของ 1 กลุ่ม (customer+currency+entryType) ณ วันที่ระบุ (0.4) — reuse
 *   listEntries/listBillPaymentsForEntries/netFxAdjustmentByEntry ตรง ๆ ไม่มีสูตรคู่ขนาน
 *   ★ เฉพาะบิลที่ eligible (isCreditEligibleForPayment — ซื้อ/ขาย + payment_method='credit' + confirmed)
 *   และเป็นบิล FX ของสกุลที่ระบุเท่านั้น — บิลที่จ่ายครบแล้ว (outstanding ≈ 0) ไม่ถูกรวมใน breakdown
 */
export async function loadOutstandingFxGroup(
  db: DB,
  tenantId: string,
  customerId: string,
  currency: string,
  entryType: FxEligibleEntryType,
  asOfDate: string
): Promise<FxOutstandingGroup> {
  const { entries } = await listEntries(db, tenantId, { customerId, entryType });
  const eligible = entries.filter(
    (e) => isCreditEligibleForPayment(e) && (e.currency ?? null) === currency && numLocal(e.fxRate) > 0
  );
  if (eligible.length === 0) {
    return { customerId, entryType, currency, outstandingFxAmount: 0, bills: [] };
  }

  const entryIds = eligible.map((e) => e.id);
  const [paymentsByEntry, notesByEntry] = await Promise.all([
    listBillPaymentsForEntries(db, tenantId, entryIds, asOfDate),
    listNotesForEntries(db, tenantId, entryIds),
  ]);
  const fxAdjByEntry = netFxAdjustmentByEntry(notesByEntry, asOfDate);

  let sumOutstanding = 0;
  const bills: FxOutstandingBillBreakdown[] = [];
  for (const e of eligible) {
    const fxLinesTotal = round2(e.lines.reduce((s, l) => s + numLocal(l.fxAmount ?? 0), 0));
    const fxPayments = (paymentsByEntry.get(e.id) ?? []).map((p) => ({
      fxAmount: numLocal(p.fxAmount ?? 0),
      payDate: p.payDate,
    }));
    const adjustment = fxAdjByEntry.get(e.id) ?? 0;
    // ★ payments/adjustment กรอง asOfDate มาแล้วที่ data layer ข้างบน — ไม่ส่ง asOfDate ซ้ำที่นี่
    const outstanding = outstandingFxForEntry(fxLinesTotal, fxPayments, adjustment);
    sumOutstanding += outstanding;
    if (!nonZero(outstanding)) continue; // จ่ายครบแล้ว — ไม่ต้องโชว์ breakdown/ไม่รวมเข้า revaluation
    bills.push({
      entryId: e.id,
      docNo: e.docNo,
      docDate: e.docDate,
      counterpartyName: e.counterpartyName,
      invoiceFxRate: numLocal(e.fxRate),
      outstandingFxAmount: round2(outstanding),
    });
  }

  return { customerId, entryType, currency, outstandingFxAmount: round2(sumOutstanding), bills };
}

/** live state ของ manual JE 1 ใบ (ไม่ใช่ cache) — null = ไม่พบแถวนี้เลย (id ผิด/ไม่มี) */
async function loadJeLiveState(
  db: DB,
  tenantId: string,
  id: string | null
): Promise<{ confirmed: boolean; deleted: boolean } | null> {
  if (!id) return null;
  const { data } = await db
    .from("manual_journal_entries")
    .select("status, deleted_at")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!data) return null;
  const r = data as { status: string; deleted_at: string | null };
  return { confirmed: r.status === "confirmed", deleted: !!r.deleted_at };
}

/**
 * สถานะ "จริง" ของ cycle 1 แถว — เช็ค live status ของ manual_journal_entries ตรง ๆ เสมอ (0.12, ⚠️
 *   สำคัญที่สุดของเฟสนี้ — ป้องกัน "status drift" ที่ทำให้ guard รั่ว) — ไม่เชื่อคอลัมน์ `status` ที่ cache ไว้
 *   - revaluation JE หาไม่พบ/ถูกลบ → 'voided' (0.14)
 *   - revaluation JE ยัง draft (ไม่ confirmed) → 'reval_draft'
 *   - revaluation confirmed แต่ยังไม่มี reversing_je_id → 'reval_draft' (defensive, สถานะกึ่งกลางที่ไม่ควร
 *     เกิดถ้า flow ถูกต้อง — ไม่ throw)
 *   - reversing JE หาไม่พบ/ถูกลบ → 'voided'
 *   - reversing JE confirmed → 'reversing_confirmed' · ยังไม่ confirmed → 'reversing_draft'
 */
export async function deriveLiveRevaluationStatus(
  db: DB,
  tenantId: string,
  row: Pick<FxPeriodRevaluation, "revaluationJeId" | "reversingJeId">
): Promise<FxPeriodRevaluationStatus> {
  const revState = await loadJeLiveState(db, tenantId, row.revaluationJeId);
  if (!revState || revState.deleted) return "voided";
  if (!revState.confirmed) return "reval_draft";

  const reversingState = await loadJeLiveState(db, tenantId, row.reversingJeId);
  if (!reversingState) return "reval_draft"; // defensive — reval confirmed แต่ยังไม่สร้าง reversing (ไม่ควรเกิด)
  if (reversingState.deleted) return "voided";
  return reversingState.confirmed ? "reversing_confirmed" : "reversing_draft";
}

/** โหลด cycle ล่าสุด (period_end_date desc) ของกลุ่ม (customer+currency+entryType) — เพดาน CYCLE_HISTORY_LIMIT */
async function listGroupCyclesDesc(
  db: DB,
  tenantId: string,
  customerId: string,
  currency: string,
  entryType: FxEligibleEntryType
): Promise<FxPeriodRevaluation[]> {
  const { data } = await db
    .from("fx_period_revaluations")
    .select(FX_REVAL_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("currency", currency)
    .eq("entry_type", entryType)
    .is("deleted_at", null)
    .order("period_end_date", { ascending: false })
    .limit(CYCLE_HISTORY_LIMIT);
  return ((data ?? []) as unknown as RawFxRevalRow[]).map(mapFxRevalRow);
}

/** หา cycle ล่าสุดที่ live-status ยังไม่ 'voided' ของกลุ่ม (ไล่จากใหม่→เก่า ข้าม voided ไปเรื่อย ๆ) */
async function findLatestActiveCycle(
  db: DB,
  tenantId: string,
  customerId: string,
  currency: string,
  entryType: FxEligibleEntryType
): Promise<{ row: FxPeriodRevaluation; liveStatus: FxPeriodRevaluationStatus } | null> {
  const rows = await listGroupCyclesDesc(db, tenantId, customerId, currency, entryType);
  for (const row of rows) {
    const liveStatus = await deriveLiveRevaluationStatus(db, tenantId, row);
    if (liveStatus !== "voided") return { row, liveStatus };
  }
  return null;
}

export type FxGuardResult = { ok: true } | { ok: false; message: string; blockingRevaluationId?: string };

/**
 * Hard-block guard #1 (0.8/0.10) — ห้ามสร้าง JV ปรับปรุงงวดถัดไปถ้ารอบก่อนหน้ายังไม่ปิดสมบูรณ์:
 *   - ไม่มีรอบก่อนหน้าที่ live-active → ผ่าน (สร้างรอบแรกได้เสมอ)
 *   - periodEndDate ใหม่ ≤ ของรอบล่าสุดที่ live-active → ปฏิเสธ (ลำดับเวลาต้องต่อเนื่อง)
 *   - รอบล่าสุดที่ live-active ยังไม่ 'reversing_confirmed' → ปฏิเสธ
 */
export async function assertNoPendingCycle(
  db: DB,
  tenantId: string,
  customerId: string,
  currency: string,
  entryType: FxEligibleEntryType,
  newPeriodEndDate: string
): Promise<FxGuardResult> {
  const latest = await findLatestActiveCycle(db, tenantId, customerId, currency, entryType);
  if (!latest) return { ok: true };
  if (newPeriodEndDate <= latest.row.periodEndDate) {
    return {
      ok: false,
      message: `วันที่สิ้นงวดใหม่ต้องอยู่หลังงวดล่าสุด (${latest.row.periodEndDate}) เสมอ`,
      blockingRevaluationId: latest.row.id,
    };
  }
  if (latest.liveStatus !== "reversing_confirmed") {
    return {
      ok: false,
      message: `ต้องยืนยันรายการกลับรายการ (reversing) ของงวด ${latest.row.periodEndDate} ให้เสร็จก่อน จึงจะสร้างรายการปรับปรุงงวดใหม่ได้`,
      blockingRevaluationId: latest.row.id,
    };
  }
  return { ok: true };
}

/**
 * Hard-block guard #2 (0.11) — ห้าม "แนะนำ realized FX" ถ้า reversing ของงวดที่เกี่ยวข้องยังไม่ confirm:
 *   หา cycle ล่าสุดของกลุ่มที่ "งวดถัดไปเริ่มแล้ว" (nextPeriodStartDate(periodEndDate) ≤ payDate) — ถ้าพบ
 *   และ live-status ยังไม่ 'reversing_confirmed' (และไม่ใช่ 'voided' — cycle ที่ถูกยกเลิกไม่บล็อกอะไร) →
 *   ปฏิเสธ · payment ที่ payDate ก่อนวันเริ่มงวดใหม่ (ชำระในงวดเดิม) ไม่ถูกบล็อกเลย
 */
export async function assertReversalConfirmedForPayment(
  db: DB,
  tenantId: string,
  customerId: string,
  currency: string,
  entryType: FxEligibleEntryType,
  payDate: string
): Promise<FxGuardResult> {
  const rows = await listGroupCyclesDesc(db, tenantId, customerId, currency, entryType);
  const relevant = rows.find((r) => nextPeriodStartDate(r.periodEndDate) <= payDate);
  if (!relevant) return { ok: true };

  const liveStatus = await deriveLiveRevaluationStatus(db, tenantId, relevant);
  if (liveStatus === "voided" || liveStatus === "reversing_confirmed") return { ok: true };
  return {
    ok: false,
    message: `ต้องยืนยันรายการกลับรายการ (reversing) ของงวดสิ้นสุด ${relevant.periodEndDate} ให้เสร็จก่อน จึงจะแนะนำกำไร/ขาดทุนจากอัตราแลกเปลี่ยนของงวดนี้ได้`,
    blockingRevaluationId: relevant.id,
  };
}

export type FxActionResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * สร้าง JV ปรับปรุงอัตราแลกเปลี่ยนปลายงวด (draft) + insert แถว fx_period_revaluations (status='reval_draft')
 *   (0.10/0.15/0.16) — ลำดับ: guard #1 ก่อนเสมอ → โหลดยอดคงค้าง → คำนวณ unrealized → ถ้า 0 ปฏิเสธ →
 *   upsertManualEntry (draft) → insert แถว
 */
export async function createFxRevaluationDraft(
  db: DB,
  tenantId: string,
  customerId: string,
  entryType: FxEligibleEntryType,
  currency: string,
  periodEndDate: string,
  closingRate: number,
  source: "bot" | "manual",
  chartByCode: ChartByCode,
  gainLossAccountCode?: string
): Promise<FxActionResult> {
  if (!DATE_RE.test(periodEndDate)) return { ok: false, message: "วันที่สิ้นงวดไม่ถูกต้อง" };
  if (!isValidCurrencyCode(currency)) return { ok: false, message: "สกุลเงินไม่ถูกต้อง" };
  const rateCheck = validateFxRate(closingRate);
  if (!rateCheck.ok) return { ok: false, message: rateCheck.message };

  // ⚠️ guard #1 (0.10) — ต้องเป็นจุดแรกสุดก่อนคำนวณ/สร้างอะไรเลย
  const guard = await assertNoPendingCycle(db, tenantId, customerId, currency, entryType, periodEndDate);
  if (!guard.ok) return { ok: false, message: guard.message };

  const group = await loadOutstandingFxGroup(db, tenantId, customerId, currency, entryType, periodEndDate);
  if (group.bills.length === 0) {
    return { ok: false, message: "ไม่พบยอดคงค้างสกุลเงินนี้ของลูกค้ารายนี้ที่ต้องปรับปรุง" };
  }

  const unrealizedAmount = computeGroupUnrealizedAmount(group.bills, entryType, rateCheck.value);
  if (!nonZero(unrealizedAmount)) {
    return { ok: false, message: "อัตราปิดเท่ากับอัตราที่บันทึกไว้พอดี — ไม่มีผลต่างอัตราแลกเปลี่ยนที่ต้องปรับปรุง" };
  }

  const arApCode = entryType === "sale" ? AR : AP;
  const gainLossCode = (gainLossAccountCode && gainLossAccountCode.trim()) || DEFAULT_FX_GAIN_LOSS_ACCOUNT_CODE;
  const sideLabel = entryType === "sale" ? "ลูกหนี้การค้า" : "เจ้าหนี้การค้า";
  const memo = `ปรับปรุงอัตราแลกเปลี่ยนปลายงวด ${periodEndDate} (${currency}) — ${sideLabel}`;

  const entryInput = buildRevaluationEntryInput(entryType, unrealizedAmount, arApCode, gainLossCode, periodEndDate, memo, {
    currency,
    closingRate: rateCheck.value,
    outstandingFxAmount: group.outstandingFxAmount,
  });
  if (!entryInput) {
    return { ok: false, message: "ไม่มีผลต่างอัตราแลกเปลี่ยนที่ต้องปรับปรุง" };
  }

  const created = await upsertManualEntry(db, tenantId, customerId, entryInput, chartByCode);
  if (!created.ok) return { ok: false, message: created.message };

  const { data, error } = await db
    .from("fx_period_revaluations")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      entry_type: entryType,
      currency,
      period_end_date: periodEndDate,
      closing_rate: rateCheck.value,
      source: source === "bot" ? "bot" : "manual",
      outstanding_fx_amount: group.outstandingFxAmount,
      unrealized_amount: unrealizedAmount,
      revaluation_je_id: created.id,
      status: "reval_draft",
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    // กันเศษ JV draft ค้างไร้เจ้าของ — ลบทิ้ง (soft-delete) ถ้า insert แถว fx_period_revaluations ไม่สำเร็จ
    await softDeleteManualEntry(db, tenantId, created.id);
    return { ok: false, message: "สร้างรายการไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id: (data as { id: string }).id };
}

/** โหลด 1 แถวของ fx_period_revaluations ตาม id (scope tenant, ไม่รวมที่ลบแล้ว) */
export async function getFxPeriodRevaluation(
  db: DB,
  tenantId: string,
  id: string
): Promise<FxPeriodRevaluation | null> {
  const { data } = await db
    .from("fx_period_revaluations")
    .select(FX_REVAL_COLUMNS)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  return mapFxRevalRow(data as unknown as RawFxRevalRow);
}

/** โหลดบรรทัดของ manual JE 1 ใบ ตรง ๆ (ใช้สร้าง reversing — สลับ debit/credit จากบรรทัดเดียวกันเป๊ะ, 0.9) */
async function loadManualEntryLinesRaw(db: DB, tenantId: string, entryId: string): Promise<ManualJournalLine[]> {
  const { data } = await db
    .from("manual_journal_entry_lines")
    .select("id, line_no, account_code, account_name, description, debit, credit, fx_currency, fx_rate, fx_amount")
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId)
    .order("line_no", { ascending: true });
  type Raw = {
    id: string;
    line_no: number;
    account_code: string;
    account_name: string | null;
    description: string | null;
    debit: number | string;
    credit: number | string;
    fx_currency?: string | null;
    fx_rate?: number | string | null;
    fx_amount?: number | string | null;
  };
  return ((data ?? []) as unknown as Raw[]).map((r) => ({
    id: r.id,
    lineNo: r.line_no,
    accountCode: r.account_code,
    accountName: r.account_name,
    description: r.description,
    debit: numLocal(r.debit),
    credit: numLocal(r.credit),
    fxCurrency: r.fx_currency ?? null,
    fxRate: r.fx_rate === null || r.fx_rate === undefined ? null : numLocal(r.fx_rate),
    fxAmount: r.fx_amount === null || r.fx_amount === undefined ? null : numLocal(r.fx_amount),
  }));
}

/**
 * ยืนยัน JV ปรับปรุง (revaluation_je_id) → confirmManualEntry เดิม (ไม่แก้ตรรกะ) → ทันทีที่สำเร็จ สร้าง JV
 *   กลับรายการ (reversing) เป็น draft ใหม่ในขั้นตอนเดียวกัน (0.9, ไม่รอ cron/วันจริง) → update แถว
 *   (reversing_je_id, status='reversing_draft') — ยืนยันซ้ำ (เคยยืนยัน+มี reversing อยู่แล้ว) → ok เฉย ๆ
 *   ไม่สร้าง reversing ซ้ำสอง
 */
export async function confirmFxRevaluation(db: DB, tenantId: string, revaluationId: string): Promise<FxActionResult> {
  const row = await getFxPeriodRevaluation(db, tenantId, revaluationId);
  if (!row) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
  if (!row.revaluationJeId) return { ok: false, message: "รายการนี้ไม่มี JV ปรับปรุงผูกอยู่ (ข้อมูลผิดปกติ)" };

  const confirmRes = await confirmManualEntry(db, tenantId, row.revaluationJeId);
  if (!confirmRes.ok) return { ok: false, message: confirmRes.message };

  if (row.reversingJeId) {
    // เคยสร้าง reversing ไปแล้ว (เช่นกดยืนยันซ้ำ) — ไม่ต้องสร้างซ้ำสอง
    return { ok: true, id: revaluationId };
  }

  const lines = await loadManualEntryLinesRaw(db, tenantId, row.revaluationJeId);
  if (lines.length === 0) {
    return { ok: false, message: "ไม่พบบรรทัดของ JV ปรับปรุง — สร้างรายการกลับรายการไม่ได้" };
  }
  const nextStart = nextPeriodStartDate(row.periodEndDate);
  const memo = `กลับรายการปรับปรุงอัตราแลกเปลี่ยนปลายงวด ${row.periodEndDate} (${row.currency}) — ⚠️ ต้องยืนยันก่อนเริ่มบันทึกบัญชีงวดใหม่`;
  const reversingInput = buildReversingEntryInput(lines, nextStart, memo);

  const chart = await listChartOfAccounts(db, tenantId);
  const chartByCode = buildChartByCode(chart);
  const createdReversing = await upsertManualEntry(db, tenantId, row.customerId, reversingInput, chartByCode);
  if (!createdReversing.ok) return { ok: false, message: createdReversing.message };

  const { error } = await db
    .from("fx_period_revaluations")
    .update({ reversing_je_id: createdReversing.id, status: "reversing_draft" })
    .eq("id", revaluationId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ยืนยันสำเร็จแต่บันทึกรายการกลับรายการไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: revaluationId };
}

/** ยืนยัน JV กลับรายการ (reversing_je_id) → confirmManualEntry เดิม → update cache status='reversing_confirmed' */
export async function confirmFxReversing(db: DB, tenantId: string, revaluationId: string): Promise<FxActionResult> {
  const row = await getFxPeriodRevaluation(db, tenantId, revaluationId);
  if (!row) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
  if (!row.reversingJeId) {
    return { ok: false, message: "รายการนี้ยังไม่มี JV กลับรายการ — ต้องยืนยัน JV ปรับปรุงก่อน" };
  }

  const confirmRes = await confirmManualEntry(db, tenantId, row.reversingJeId);
  if (!confirmRes.ok) return { ok: false, message: confirmRes.message };

  const { error } = await db
    .from("fx_period_revaluations")
    .update({ status: "reversing_confirmed" })
    .eq("id", revaluationId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ยืนยันไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: revaluationId };
}

/**
 * ยกเลิกการยืนยัน JV กลับรายการ (0.13 — ทางเข้าที่ "ถูกต้อง" ทางเดียวสำหรับ reversing_je_id นี้ นอกเหนือจาก
 *   confirmManualEntryAction/unconfirmManualEntryAction ทั่วไปที่ T137 บล็อกไว้แล้ว) — update cache กลับเป็น
 *   'reversing_draft' (status drift ที่ตามมา 0.12 อธิบายไว้แล้วว่าเป็นความเสี่ยงที่ยอมรับ — mitigate ด้วย
 *   guard #1/#2 เช็ค live status จริงเสมอ ไม่ใช่คอลัมน์นี้)
 */
export async function unconfirmFxReversing(db: DB, tenantId: string, revaluationId: string): Promise<FxActionResult> {
  const row = await getFxPeriodRevaluation(db, tenantId, revaluationId);
  if (!row) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
  if (!row.reversingJeId) return { ok: false, message: "รายการนี้ไม่มี JV กลับรายการ" };

  const res = await unconfirmManualEntry(db, tenantId, row.reversingJeId);
  if (!res.ok) return { ok: false, message: res.message };

  const { error } = await db
    .from("fx_period_revaluations")
    .update({ status: "reversing_draft" })
    .eq("id", revaluationId)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ยกเลิกการยืนยันไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: revaluationId };
}

/**
 * ตรวจ+ซ่อม cache status ให้ตรงกับ live status จริง (0.14 mirror resetFxGainLossNote ของเฟส 10a) — ใช้ตอน
 *   list/แสดงผล เผื่อ JE ที่ผูกไว้ถูก soft-delete ไปหลังบ้าน (นักบัญชีลบผ่านหน้า journal-entry ปกติ) → คอลัมน์
 *   status ที่ cache ไว้จะค้างผิดถ้าไม่ refresh — คืน live status ปัจจุบัน (อัปเดต DB ด้วยถ้าไม่ตรงกับ cache)
 */
export async function voidFxPeriodRevaluationIfJeDeleted(
  db: DB,
  tenantId: string,
  revaluationId: string
): Promise<FxPeriodRevaluationStatus | null> {
  const row = await getFxPeriodRevaluation(db, tenantId, revaluationId);
  if (!row) return null;
  const live = await deriveLiveRevaluationStatus(db, tenantId, row);
  if (live !== row.status) {
    await db.from("fx_period_revaluations").update({ status: live }).eq("id", revaluationId).eq("tenant_id", tenantId);
  }
  return live;
}

/** แถวพร้อม live status (ไม่ใช่แค่ cache) — สำหรับหน้ารายงาน (T134) */
export type FxPeriodRevaluationWithLiveStatus = FxPeriodRevaluation & { liveStatus: FxPeriodRevaluationStatus };

/** รายการ fx_period_revaluations ทั้งหมดของลูกค้า 1 ราย (เรียงงวดล่าสุดก่อน) พร้อม live status ที่ refresh แล้ว */
export async function listFxPeriodRevaluations(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<FxPeriodRevaluationWithLiveStatus[]> {
  const { data } = await db
    .from("fx_period_revaluations")
    .select(FX_REVAL_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("period_end_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  const rows = ((data ?? []) as unknown as RawFxRevalRow[]).map(mapFxRevalRow);

  const out: FxPeriodRevaluationWithLiveStatus[] = [];
  for (const row of rows) {
    const liveStatus = await deriveLiveRevaluationStatus(db, tenantId, row);
    if (liveStatus !== row.status) {
      await db.from("fx_period_revaluations").update({ status: liveStatus }).eq("id", row.id).eq("tenant_id", tenantId);
    }
    out.push({ ...row, liveStatus });
  }
  return out;
}

/**
 * นับ cycle ที่ "ค้างยืนยัน reversing" เกิน thresholdDays วัน (0.18 — hint UI เท่านั้น ไม่ block อะไร) —
 *   เช็ค live status จริงเสมอ (ไม่เชื่อ cache — แม้จะกรองเบื้องต้นด้วย cache='reversing_draft' เพื่อลด query
 *   ก็ตาม สุดท้ายต้อง deriveLiveRevaluationStatus ยืนยันอีกครั้งก่อนนับ)
 *   @param asOfDate optional — ไม่ส่ง = ใช้วันนี้ตามเวลาไทย (ให้ testable ผ่าน parameter นี้)
 */
export async function countOverdueUnconfirmedReversals(
  db: DB,
  tenantId: string,
  customerId?: string,
  thresholdDays = 7,
  asOfDate?: string
): Promise<number> {
  let q = db
    .from("fx_period_revaluations")
    .select(FX_REVAL_COLUMNS)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .eq("status", "reversing_draft")
    .limit(LIST_LIMIT);
  if (customerId) q = q.eq("customer_id", customerId);
  const { data } = await q;
  const rows = ((data ?? []) as unknown as RawFxRevalRow[]).map(mapFxRevalRow);

  const today = asOfDate && DATE_RE.test(asOfDate) ? asOfDate : todayThaiIso();
  let count = 0;
  for (const row of rows) {
    const nextStart = nextPeriodStartDate(row.periodEndDate);
    if (daysBetweenIso(nextStart, today) < thresholdDays) continue;
    const live = await deriveLiveRevaluationStatus(db, tenantId, row);
    if (live === "reversing_draft") count++;
  }
  return count;
}

/**
 * `id` นี้เป็น revaluation_je_id หรือ reversing_je_id ของ fx_period_revaluations แถวใดที่ยังไม่จบ cycle
 *   หรือไม่ (0.13 — ใช้ที่ journal-entry/actions.ts บล็อก confirm/unconfirm generic) — แถวที่ cache='voided'
 *   แล้ว (JE เดิมถูกลบไปแล้ว) → ไม่ถูกนับว่าเป็นข้อจำกัดอีก (คืน false ปล่อยผ่านปกติ, ตาม T137 DoD — ไม่มี
 *   อะไรให้ปกป้องอีกต่อไปเมื่อ voided แล้ว) — ใช้ cache ตรงนี้ได้ (ไม่ใช่ guard ทางการเงิน) เพราะทุก transition
 *   ที่ "ถูกต้อง" ล้วนอัปเดต cache ให้ตรงเสมอ (ผ่าน wrapper ของไฟล์นี้เท่านั้น — ไม่มีทางอื่นแก้ id เหล่านี้)
 */
export async function isRevaluationOrReversingJeId(db: DB, tenantId: string, id: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    db.from("fx_period_revaluations").select("status").eq("tenant_id", tenantId).eq("revaluation_je_id", id).is("deleted_at", null).maybeSingle(),
    db.from("fx_period_revaluations").select("status").eq("tenant_id", tenantId).eq("reversing_je_id", id).is("deleted_at", null).maybeSingle(),
  ]);
  const statusA = (a.data as { status?: string } | null)?.status;
  const statusB = (b.data as { status?: string } | null)?.status;
  return (!!statusA && statusA !== "voided") || (!!statusB && statusB !== "voided");
}

/**
 * ชุด id ของ JE (revaluation_je_id/reversing_je_id) ที่ยังไม่จบ cycle ของลูกค้า 1 ราย — ใช้ที่
 *   journal-entry/JournalEntryPanel.tsx ซ่อนปุ่ม "ยืนยัน"/"ยกเลิกยืนยัน" generic (0.13, UI hint —
 *   cache status ก็พอสำหรับจุดนี้ ไม่ใช่ guard ทางการเงิน ตรงกับที่แผนระบุไว้)
 */
export async function listActiveFxJeIds(db: DB, tenantId: string, customerId: string): Promise<Set<string>> {
  const { data } = await db
    .from("fx_period_revaluations")
    .select("revaluation_je_id, reversing_je_id, status")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .limit(LIST_LIMIT);
  const ids = new Set<string>();
  for (const r of (data ?? []) as { revaluation_je_id: string | null; reversing_je_id: string | null; status: string }[]) {
    if (r.status === "reversing_confirmed" || r.status === "voided") continue;
    if (r.revaluation_je_id) ids.add(r.revaluation_je_id);
    if (r.reversing_je_id) ids.add(r.reversing_je_id);
  }
  return ids;
}

/** ผูก customerId ของ fx_period_revaluations 1 แถว (สำหรับ assertCustomerInScope ที่ action layer) */
export async function getFxPeriodRevaluationCustomerId(
  db: DB,
  tenantId: string,
  revaluationId: string
): Promise<string | null> {
  const row = await getFxPeriodRevaluation(db, tenantId, revaluationId);
  return row?.customerId ?? null;
}
