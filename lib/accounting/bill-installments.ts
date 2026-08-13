/**
 * แผนงวดผ่อนชำระบนบิลเชื่อ AR/AP (bill_installments) — data layer (DB) + validate + pure status calc
 *
 * บริบท: wishlist ข้อ 7 — ต่อยอดกลไก "รับ/จ่ายเงินแยกจากบิล" เดิม (bill-payments.ts, เฟส 2 ส่วน E) ที่
 *   รองรับบิลเชื่อ 1 ใบรับ/จ่ายเงินหลายงวดอยู่แล้ว แต่ยังไม่มี "แผนงวดชำระล่วงหน้า" (จำนวนงวด/กำหนดวัน/
 *   ยอดต่องวด) — ไฟล์นี้เพิ่มแค่ชั้น "แผนอ้างอิง" ทับบิลเดิม ไม่แก้ตรรกะ bill_payments/AR-AP/ledger เลย
 * ★★★ แผนงวดชำระไม่ใช่รายการทางบัญชี — ไม่มีการ post JE เกิดจากการตั้ง/แก้/ลบแผน การรับ/จ่ายเงินจริงยังผ่าน
 *   recordBillPayment เดิมทุกประการ สถานะ "ชำระแล้ว/เกินกำหนด/ยังไม่ครบกำหนด" ต่องวดคำนวณสด ๆ (pure,
 *   ไม่ persist) โดยเทียบยอดชำระจริงสะสม (จาก bill_payments) กับยอดตามแผนสะสม ณ งวดนั้น — ถ้าลูกค้าจ่ายเกิน/
 *   ต่ำกว่าแผน หรือจ่ายก่อน/หลังกำหนด ระบบไม่บังคับผูกเงินแต่ละก้อนเข้ากับงวดใดงวดหนึ่งตรง ๆ (เรียบง่ายกว่า
 *   และทนทานกว่าการบังคับจับคู่ 1:1 ซึ่งไม่ตรงกับพฤติกรรมการจ่ายเงินจริง)
 * ★ ยอดรวมของแผนต้อง "เท่ากับยอดเต็มของบิล" เสมอ (billNetTotal เดิม จาก bill-payments.ts) ไม่ใช่ยอดคงค้าง
 *   ณ ตอนตั้งแผน — เพื่อให้แผนสะท้อนภาพรวมทั้งบิลตั้งแต่ต้น ไม่ว่าจะเคยมีการจ่ายเงินมาก่อนตั้งแผนหรือไม่
 * ★ ไม่ soft-delete — แก้แผนใหม่ = ลบแถวเดิมทั้งหมดของบิลนั้นแล้ว insert ชุดใหม่ (ไม่ใช่ transaction ทางการเงิน
 *   ต่างจาก bill_payments ที่ต้อง void เก็บ audit trail)
 * ★ ทุก query/write กรอง tenant_id (จาก session) — assertCustomerInScope ทำที่ actions.ts ชั้นบน
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidCalendarDate } from "@/lib/accounting/bank-reconciliation";
import { chunkIds } from "@/lib/accounting/id-chunk";
import { round2 } from "@/lib/accounting/queries";
import { EPSILON } from "@/lib/accounting/statement-config";
import { isCreditEligibleForPayment, billNetTotal, getBillPaymentScope } from "@/lib/accounting/bill-payments";
import type { BillEntryLine } from "@/lib/accounting/queries";

type DB = SupabaseClient;

/** เพดานจำนวนงวด (กันพิมพ์ผิด/payload ใหญ่ผิดปกติ — ผ่อนสูงสุด 60 งวด ~5 ปีต่อเดือน) */
export const MAX_INSTALLMENTS = 60;
/** อย่างน้อย 2 งวด — 1 งวดไม่ใช่ "ผ่อน" (เท่ากับจ่ายเต็มจำนวนธรรมดา ใช้ bill_payments ตรง ๆ พอ) */
export const MIN_INSTALLMENTS = 2;

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function numLocal(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------
// ชนิดข้อมูล
// ---------------------------------------------------------------------

/** 1 งวดของแผนผ่อนชำระ (โหลดจาก DB แล้ว) */
export type BillInstallment = {
  id: string;
  tenantId: string;
  entryId: string;
  installmentNo: number;
  dueDate: string;
  plannedAmount: number;
  createdAt: string;
};

/** สถานะงวด — คำนวณสด ๆ เสมอ (pure, ไม่ persist) */
export type InstallmentStatus = "paid" | "overdue" | "upcoming";

export type InstallmentWithStatus = BillInstallment & {
  status: InstallmentStatus;
  /** ยอดตามแผนสะสมถึงงวดนี้ (งวด 1..N) */
  cumulativePlanned: number;
};

/** input ดิบต่องวด จาก client */
export type InstallmentRowInput = {
  dueDate: unknown;
  amount: unknown;
};

export type ValidatedInstallmentRow = {
  dueDate: string;
  plannedAmount: number;
};

export type InstallmentPlanValidationResult =
  | { ok: true; value: ValidatedInstallmentRow[] }
  | { ok: false; message: string };

// ---------------------------------------------------------------------
// pure — validate แผนงวดชำระ
// ---------------------------------------------------------------------

/**
 * validate + sanitize แผนงวดชำระ — ปฏิเสธเสมอถ้า:
 *   - จำนวนงวดน้อยกว่า 2 หรือมากกว่า MAX_INSTALLMENTS
 *   - วันครบกำหนดของงวดใดงวดหนึ่งผิดรูปแบบ/ไม่ใช่วันที่จริง
 *   - วันครบกำหนดไม่เรียงจากน้อยไปมากตามลำดับงวด (งวดถัดไปต้องครบกำหนดหลังงวดก่อนหน้าเสมอ)
 *   - ยอดงวดใดงวดหนึ่งไม่มากกว่า 0
 *   - ยอดรวมทุกงวด ≠ ยอดเต็มของบิล (billNet) — ต้องเท่ากันเป๊ะ (ปัดเศษ 2 ตำแหน่ง)
 */
export function validateInstallmentPlanInput(
  rows: InstallmentRowInput[],
  billNet: number
): InstallmentPlanValidationResult {
  if (rows.length < MIN_INSTALLMENTS) {
    return { ok: false, message: `แผนผ่อนชำระต้องมีอย่างน้อย ${MIN_INSTALLMENTS} งวด` };
  }
  if (rows.length > MAX_INSTALLMENTS) {
    return { ok: false, message: `แผนผ่อนชำระมีได้ไม่เกิน ${MAX_INSTALLMENTS} งวด` };
  }

  const value: ValidatedInstallmentRow[] = [];
  let prevDate = "";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const dueDate = typeof r.dueDate === "string" && DATE_RE.test(r.dueDate) ? r.dueDate : "";
    if (!dueDate || !isValidCalendarDate(dueDate)) {
      return { ok: false, message: `งวดที่ ${i + 1}: วันครบกำหนดไม่ถูกต้อง (YYYY-MM-DD)` };
    }
    if (prevDate && dueDate <= prevDate) {
      return { ok: false, message: `งวดที่ ${i + 1}: วันครบกำหนดต้องอยู่หลังงวดก่อนหน้าเสมอ` };
    }
    prevDate = dueDate;

    const rawAmount = numLocal(r.amount);
    if (!(rawAmount > 0)) {
      return { ok: false, message: `งวดที่ ${i + 1}: ยอดชำระต้องมากกว่า 0` };
    }
    value.push({ dueDate, plannedAmount: round2(rawAmount) });
  }

  const sum = round2(value.reduce((s, r) => s + r.plannedAmount, 0));
  const net = round2(billNet);
  if (Math.abs(sum - net) > EPSILON) {
    return {
      ok: false,
      message: `ยอดรวมทุกงวด (${sum.toFixed(2)}) ต้องเท่ากับยอดเต็มของบิล (${net.toFixed(2)}) พอดี`,
    };
  }

  return { ok: true, value };
}

// ---------------------------------------------------------------------
// pure — สถานะต่องวด (คำนวณสด ๆ ไม่ persist)
// ---------------------------------------------------------------------

/**
 * แปะสถานะต่องวด — เรียงตาม installmentNo เสมอ (caller ควร sort ก่อนถ้าไม่แน่ใจลำดับจาก DB)
 *   - paid: ยอดชำระจริงสะสม (totalPaid) ≥ ยอดตามแผนสะสมถึงงวดนี้
 *   - overdue: ยังไม่ paid และวันครบกำหนด < asOfDate
 *   - upcoming: ยังไม่ paid และวันครบกำหนด ≥ asOfDate
 * @param totalPaid ยอดชำระจริงสะสมทั้งหมดของบิล (Σ bill_payments ที่ยังไม่ถูกยกเลิก)
 * @param asOfDate YYYY-MM-DD — ปกติคือวันนี้
 */
export function computeInstallmentStatuses(
  installments: BillInstallment[],
  totalPaid: number,
  asOfDate: string
): InstallmentWithStatus[] {
  const sorted = [...installments].sort((a, b) => a.installmentNo - b.installmentNo);
  const paid = round2(totalPaid);
  let cumulative = 0;
  return sorted.map((inst) => {
    cumulative = round2(cumulative + inst.plannedAmount);
    const isPaid = paid + EPSILON >= cumulative;
    const status: InstallmentStatus = isPaid ? "paid" : inst.dueDate < asOfDate ? "overdue" : "upcoming";
    return { ...inst, status, cumulativePlanned: cumulative };
  });
}

// ---------------------------------------------------------------------
// data layer (DB)
// ---------------------------------------------------------------------

const LIST_LIMIT = 200;
const BULK_LIST_LIMIT = 5000;

type RawInstallment = {
  id: string;
  tenant_id: string;
  entry_id: string;
  installment_no: number;
  due_date: string;
  planned_amount: number | string;
  created_at: string;
};

const COLUMNS = "id, tenant_id, entry_id, installment_no, due_date, planned_amount, created_at";

function mapRow(r: RawInstallment): BillInstallment {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    entryId: r.entry_id,
    installmentNo: r.installment_no,
    dueDate: r.due_date,
    plannedAmount: round2(numLocal(r.planned_amount)),
    createdAt: r.created_at,
  };
}

/** แผนงวดชำระของบิล 1 ใบ (เรียงตามงวด) — array ว่าง = ยังไม่มีแผน */
export async function listInstallments(db: DB, tenantId: string, entryId: string): Promise<BillInstallment[]> {
  const { data } = await db
    .from("bill_installments")
    .select(COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId)
    .order("installment_no", { ascending: true })
    .limit(LIST_LIMIT);
  return ((data ?? []) as unknown as RawInstallment[]).map(mapRow);
}

/** แผนงวดชำระของหลายบิลพร้อมกัน (ใช้กับหน้ารายการรับ/จ่ายเงิน) → Map<entryId, BillInstallment[]> */
export async function listInstallmentsForEntries(
  db: DB,
  tenantId: string,
  entryIds: string[]
): Promise<Map<string, BillInstallment[]>> {
  const result = new Map<string, BillInstallment[]>();
  if (entryIds.length === 0) return result;
  const chunks = await Promise.all(
    chunkIds(entryIds).map((ids) =>
      db
        .from("bill_installments")
        .select(COLUMNS)
        .eq("tenant_id", tenantId)
        .in("entry_id", ids)
        .order("installment_no", { ascending: true })
        .limit(BULK_LIST_LIMIT)
    )
  );
  const rows = chunks.flatMap(({ data }) => (data ?? []) as unknown as RawInstallment[]);
  for (const r of rows) {
    const inst = mapRow(r);
    const arr = result.get(inst.entryId) ?? [];
    arr.push(inst);
    result.set(inst.entryId, arr);
  }
  return result;
}

type RawLineAmount = {
  amount: number | string | null;
  vat_amount: number | string | null;
  wht_amount: number | string | null;
};

/** โหลด amount/vat/wht ต่อบรรทัดของบิล (ใช้คำนวณยอดเต็มผ่าน billNetTotal) — มิเรอร์ loadEntryLineAmounts
 *   ภายในของ bill-payments.ts (duplication เล็ก ๆ ตั้งใจ ไม่ import ข้ามไฟล์เพราะฟังก์ชันนั้นไม่ export) */
async function loadEntryLineAmounts(db: DB, tenantId: string, entryId: string): Promise<Pick<BillEntryLine, "amount" | "vatAmount" | "whtAmount">[]> {
  const { data } = await db
    .from("bill_entry_lines")
    .select("amount, vat_amount, wht_amount")
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId);
  return ((data ?? []) as RawLineAmount[]).map((r) => ({
    amount: numLocal(r.amount),
    vatAmount: numLocal(r.vat_amount),
    whtAmount: numLocal(r.wht_amount),
  }));
}

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline */
export type InstallmentPlanActionResult = { ok: true } | { ok: false; message: string };

/**
 * ตั้ง/แก้แผนงวดชำระของบิล 1 ใบ — validate ซ้ำฝั่ง server เสมอ (ไม่เชื่อ client)
 *   - เฉพาะบิลเชื่อที่ยืนยันแล้วเท่านั้น (isCreditEligibleForPayment)
 *   - ยอดรวมทุกงวดต้องเท่ากับยอดเต็มของบิล (re-fetch จาก DB เสมอ ไม่เชื่อ client)
 *   - แก้แผนเดิม = ลบแถวเดิมทั้งหมดของบิลนี้ก่อน แล้ว insert ชุดใหม่ — ผ่าน RPC `set_bill_installment_plan`
 *     (ทรานแซกชันเดียวใน Postgres, migration 0107) กันเคส insert ล้มเหลวหลัง delete สำเร็จ (จะเหลือบิล
 *     ไม่มีแผนเลย) และกัน 2 คำขอพร้อมกันทำให้สถานะครึ่ง ๆ กลาง ๆ — ไม่ soft-delete (ดูคอมเมนต์หัวไฟล์)
 */
export async function setInstallmentPlan(
  db: DB,
  tenantId: string,
  entryId: string,
  rows: InstallmentRowInput[]
): Promise<InstallmentPlanActionResult> {
  const scope = await getBillPaymentScope(db, tenantId, entryId);
  if (!scope) return { ok: false, message: "ไม่พบบิล (อาจถูกลบไปแล้ว)" };
  if (!isCreditEligibleForPayment({ entryType: scope.entryType, paymentMethod: scope.paymentMethod, status: scope.status })) {
    return { ok: false, message: "ตั้งแผนผ่อนชำระได้เฉพาะบิลเชื่อที่ยืนยันแล้วเท่านั้น" };
  }

  const lines = await loadEntryLineAmounts(db, tenantId, entryId);
  const net = billNetTotal({ lines });
  const v = validateInstallmentPlanInput(rows, net);
  if (!v.ok) return { ok: false, message: v.message };

  const payload = v.value.map((r, i) => ({
    installment_no: i + 1,
    due_date: r.dueDate,
    planned_amount: r.plannedAmount,
  }));
  const { error } = await db.rpc("set_bill_installment_plan", {
    p_tenant_id: tenantId,
    p_entry_id: entryId,
    p_installments: payload,
  });
  if (error) return { ok: false, message: "บันทึกแผนไม่สำเร็จ กรุณาลองใหม่" };

  return { ok: true };
}

/** ลบแผนงวดชำระทั้งหมดของบิล 1 ใบ (กลับไปสถานะ "ยังไม่มีแผน") */
export async function clearInstallmentPlan(db: DB, tenantId: string, entryId: string): Promise<InstallmentPlanActionResult> {
  const { error } = await db.from("bill_installments").delete().eq("tenant_id", tenantId).eq("entry_id", entryId);
  if (error) return { ok: false, message: "ลบแผนไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true };
}
