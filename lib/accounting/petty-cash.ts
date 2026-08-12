/**
 * เงินสดย่อย (petty cash, ระบบ imprest) — data layer (DB) + validate + pure mapper (wishlist ข้อ 3)
 *
 * บริบท: กองทุนเงินสดย่อยคงที่ (float amount) 1 กองทุนต่อ (tenant, customer) — บันทึกใบเบิกย่อยทีละใบ
 *   (status='pending') โดยไม่ลง JE ทันที แล้วค่อย "เคลียร์" (settle) รวมหลายใบเป็น manual JE เดียว
 *   (Dr ค่าใช้จ่ายแต่ละประเภทตามที่เบิก = Cr บัญชีต้นทางที่เติมเงินคืน) — ★ สร้างเป็นดราฟต์เสมอ ไม่เคย
 *   auto-ยืนยัน (mirror platform-report-je.ts/suggestFxGainLossNoteAction — นักบัญชีตรวจ/ยืนยันเองที่
 *   หน้า "ลงบันทึกบัญชีเอง")
 *
 * ★ ยอดคงเหลือ (balance) ไม่เก็บเป็นคอลัมน์ — คำนวณสดจาก floatAmount − Σ(voucher ที่ยัง pending) เสมอ
 *   (เหมือน billOutstanding — กันข้อมูล 2 แหล่งไม่ตรงกัน)
 * ★ ทุก query/write กรอง tenant_id + customer_id เสมอ · IDOR-safe: getVoucherScope derive scope จาก
 *   voucher id ที่กำลังเขียนจริง (ไม่เชื่อ customerId/fundId จาก client ลำพัง — mirror payroll-employees.ts)
 * ★ soft-delete (deleted_at) — ไม่ลบจริง (pattern เดิมทั้งระบบ)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/accounting/queries";
import { isValidCalendarDate } from "@/lib/accounting/bank-reconciliation";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { ACCOUNT_CODE_MAX } from "@/lib/accounting/manual-journal";
import type { ManualEntryInput, ManualEntryLineInput } from "@/lib/accounting/manual-journal";

type DB = SupabaseClient;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DESCRIPTION_MAX = 200;
export const RECEIPT_NO_MAX = 50;
export const FUND_NAME_MAX = 100;
export const DEFAULT_CASH_ACCOUNT_CODE = "1015"; // เงินสดย่อย (seed ไว้แล้วจาก migration 0063)
export const DEFAULT_SOURCE_ACCOUNT_CODE = "1020"; // เงินฝากธนาคาร #1

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

// ---------------------------------------------------------------------
// กองทุนเงินสดย่อย (petty_cash_funds)
// ---------------------------------------------------------------------

export type PettyCashFund = {
  id: string;
  tenantId: string;
  customerId: string;
  fundName: string;
  floatAmount: number;
  cashAccountCode: string;
  sourceAccountCode: string;
  createdAt: string;
  updatedAt: string;
};

export type PettyCashFundInput = {
  fundName?: unknown;
  floatAmount: unknown;
  cashAccountCode: unknown;
  sourceAccountCode: unknown;
};

type ValidatedFund = { fundName: string; floatAmount: number; cashAccountCode: string; sourceAccountCode: string };
export type PettyCashFundValidationResult = { ok: true; value: ValidatedFund } | { ok: false; message: string };
export type PettyCashActionResult = { ok: true; id: string } | { ok: false; message: string };

function requireAccountInCategory(
  code: string | null,
  label: string,
  chartByCode: ChartByCode,
  allowedCategories: string[]
): { ok: true } | { ok: false; message: string } {
  if (!code) return { ok: false, message: `ต้องเลือก${label}` };
  const acc = chartByCode[code];
  if (!acc) return { ok: false, message: `รหัสบัญชี "${code}" (${label}) ไม่อยู่ในผังบัญชี` };
  if (!allowedCategories.includes(acc.category)) {
    return { ok: false, message: `${label} ต้องอยู่ในหมวด ${allowedCategories.join("/")}` };
  }
  return { ok: true };
}

export function validatePettyCashFundInput(
  input: PettyCashFundInput,
  chartByCode: ChartByCode
): PettyCashFundValidationResult {
  const fundName = clampText(input.fundName, FUND_NAME_MAX) ?? "เงินสดย่อย";

  const floatAmountNum = typeof input.floatAmount === "number" ? input.floatAmount : Number(input.floatAmount);
  if (!Number.isFinite(floatAmountNum) || floatAmountNum < 0) {
    return { ok: false, message: "ยอดเงินสดย่อยคงที่ต้องเป็นตัวเลขไม่ติดลบ" };
  }

  const cashAccountCode = clampText(input.cashAccountCode, ACCOUNT_CODE_MAX);
  const r1 = requireAccountInCategory(cashAccountCode, "รหัสบัญชีเงินสดย่อย", chartByCode, ["สินทรัพย์"]);
  if (!r1.ok) return r1;

  const sourceAccountCode = clampText(input.sourceAccountCode, ACCOUNT_CODE_MAX);
  const r2 = requireAccountInCategory(sourceAccountCode, "รหัสบัญชีต้นทางที่เติมเงินคืน", chartByCode, ["สินทรัพย์"]);
  if (!r2.ok) return r2;

  return {
    ok: true,
    value: { fundName, floatAmount: round2(floatAmountNum), cashAccountCode: cashAccountCode as string, sourceAccountCode: sourceAccountCode as string },
  };
}

type RawFundRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  fund_name: string;
  float_amount: number | string;
  cash_account_code: string;
  source_account_code: string;
  created_at: string;
  updated_at: string;
};
const FUND_COLUMNS =
  "id, tenant_id, customer_id, fund_name, float_amount, cash_account_code, source_account_code, created_at, updated_at";

function mapFundRow(r: RawFundRow): PettyCashFund {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    fundName: r.fund_name,
    floatAmount: round2(Number(r.float_amount)),
    cashAccountCode: r.cash_account_code,
    sourceAccountCode: r.source_account_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getFund(db: DB, tenantId: string, customerId: string): Promise<PettyCashFund | null> {
  const { data } = await db
    .from("petty_cash_funds")
    .select(FUND_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!data) return null;
  return mapFundRow(data as unknown as RawFundRow);
}

/** โหลดกองทุนของลูกค้า 1 ราย — ถ้ายังไม่มีแถว สร้างให้ทันที (float_amount=0 — นักบัญชีต้องตั้งเองก่อนใช้จริง) */
export async function getOrCreateDefaultFund(db: DB, tenantId: string, customerId: string): Promise<PettyCashFund> {
  const existing = await getFund(db, tenantId, customerId);
  if (existing) return existing;

  const defaults = {
    tenant_id: tenantId,
    customer_id: customerId,
    fund_name: "เงินสดย่อย",
    float_amount: 0,
    cash_account_code: DEFAULT_CASH_ACCOUNT_CODE,
    source_account_code: DEFAULT_SOURCE_ACCOUNT_CODE,
  };
  const { data, error } = await db.from("petty_cash_funds").insert(defaults).select(FUND_COLUMNS).maybeSingle();
  if (error || !data) {
    const retry = await getFund(db, tenantId, customerId);
    if (retry) return retry;
    return mapFundRow({ id: "", ...defaults } as unknown as RawFundRow);
  }
  return mapFundRow(data as unknown as RawFundRow);
}

export async function upsertFund(
  db: DB,
  tenantId: string,
  customerId: string,
  input: PettyCashFundInput,
  chartByCode: ChartByCode
): Promise<PettyCashActionResult> {
  const v = validatePettyCashFundInput(input, chartByCode);
  if (!v.ok) return { ok: false, message: v.message };

  const payload = {
    fund_name: v.value.fundName,
    float_amount: v.value.floatAmount,
    cash_account_code: v.value.cashAccountCode,
    source_account_code: v.value.sourceAccountCode,
  };

  const existing = await getFund(db, tenantId, customerId);
  if (existing) {
    const { error } = await db.from("petty_cash_funds").update(payload).eq("id", existing.id).eq("tenant_id", tenantId);
    if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, id: existing.id };
  }

  const { data, error } = await db
    .from("petty_cash_funds")
    .insert({ tenant_id: tenantId, customer_id: customerId, ...payload })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: (data as { id: string }).id };
}

// ---------------------------------------------------------------------
// ใบเบิกเงินสดย่อย (petty_cash_vouchers)
// ---------------------------------------------------------------------

export type PettyCashVoucherStatus = "pending" | "settled";

export type PettyCashVoucher = {
  id: string;
  tenantId: string;
  customerId: string;
  fundId: string;
  voucherDate: string;
  description: string | null;
  categoryAccountCode: string;
  categoryAccountName: string | null;
  amount: number;
  receiptNo: string | null;
  status: PettyCashVoucherStatus;
  settledJeId: string | null;
  settledAt: string | null;
  createdAt: string;
};

export type PettyCashVoucherInput = {
  voucherDate: unknown;
  description?: unknown;
  categoryAccountCode: unknown;
  amount: unknown;
  receiptNo?: unknown;
};

type ValidatedVoucher = {
  voucherDate: string;
  description: string | null;
  categoryAccountCode: string;
  amount: number;
  receiptNo: string | null;
};
export type PettyCashVoucherValidationResult = { ok: true; value: ValidatedVoucher } | { ok: false; message: string };

export function validatePettyCashVoucherInput(
  input: PettyCashVoucherInput,
  chartByCode: ChartByCode
): PettyCashVoucherValidationResult {
  const voucherDate = typeof input.voucherDate === "string" ? input.voucherDate.trim() : "";
  if (!DATE_RE.test(voucherDate) || !isValidCalendarDate(voucherDate)) {
    return { ok: false, message: "ต้องระบุวันที่ใบเบิกให้ถูกรูปแบบ (YYYY-MM-DD)" };
  }

  const categoryAccountCode = clampText(input.categoryAccountCode, ACCOUNT_CODE_MAX);
  const r1 = requireAccountInCategory(categoryAccountCode, "รหัสบัญชีค่าใช้จ่าย", chartByCode, ["ค่าใช้จ่าย"]);
  if (!r1.ok) return r1;

  const amountNum = typeof input.amount === "number" ? input.amount : Number(input.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { ok: false, message: "จำนวนเงินต้องเป็นตัวเลขมากกว่า 0" };
  }

  const description = clampText(input.description, DESCRIPTION_MAX);
  const receiptNo = clampText(input.receiptNo, RECEIPT_NO_MAX);

  return {
    ok: true,
    value: { voucherDate, description, categoryAccountCode: categoryAccountCode as string, amount: round2(amountNum), receiptNo },
  };
}

type RawVoucherRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  fund_id: string;
  voucher_date: string;
  description: string | null;
  category_account_code: string;
  amount: number | string;
  receipt_no: string | null;
  status: PettyCashVoucherStatus;
  settled_je_id: string | null;
  settled_at: string | null;
  created_at: string;
};
const VOUCHER_COLUMNS =
  "id, tenant_id, customer_id, fund_id, voucher_date, description, category_account_code, amount, receipt_no, status, settled_je_id, settled_at, created_at";

function mapVoucherRow(r: RawVoucherRow, chartByCode: ChartByCode): PettyCashVoucher {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    fundId: r.fund_id,
    voucherDate: r.voucher_date,
    description: r.description,
    categoryAccountCode: r.category_account_code,
    categoryAccountName: chartByCode[r.category_account_code]?.name ?? null,
    amount: round2(Number(r.amount)),
    receiptNo: r.receipt_no,
    status: r.status,
    settledJeId: r.settled_je_id,
    settledAt: r.settled_at,
    createdAt: r.created_at,
  };
}

/** รายการใบเบิกของกองทุน 1 กองทุน — เรียงวันที่ใหม่→เก่า */
export async function listVouchers(
  db: DB,
  tenantId: string,
  customerId: string,
  fundId: string,
  chartByCode: ChartByCode,
  opts: { status?: PettyCashVoucherStatus } = {}
): Promise<PettyCashVoucher[]> {
  let q = db
    .from("petty_cash_vouchers")
    .select(VOUCHER_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("fund_id", fundId)
    .is("deleted_at", null);
  if (opts.status) q = q.eq("status", opts.status);
  const { data, error } = await q.order("voucher_date", { ascending: false }).limit(2000);
  if (error || !data) return [];
  return (data as unknown as RawVoucherRow[]).map((r) => mapVoucherRow(r, chartByCode));
}

/** โหลดสโคปของใบเบิก 1 ใบ (IDOR-safe — derive จาก voucher id ที่กำลังเขียนจริง) */
export async function getVoucherScope(
  db: DB,
  tenantId: string,
  id: string
): Promise<{ customerId: string; fundId: string; status: PettyCashVoucherStatus } | null> {
  const { data } = await db
    .from("petty_cash_vouchers")
    .select("customer_id, fund_id, status")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as { customer_id: string; fund_id: string; status: PettyCashVoucherStatus };
  return { customerId: r.customer_id, fundId: r.fund_id, status: r.status };
}

export async function createVoucher(
  db: DB,
  tenantId: string,
  customerId: string,
  fundId: string,
  input: PettyCashVoucherInput,
  chartByCode: ChartByCode
): Promise<PettyCashActionResult> {
  const v = validatePettyCashVoucherInput(input, chartByCode);
  if (!v.ok) return { ok: false, message: v.message };

  // ★ โหลดกองทุนจริงจาก DB ตาม (tenantId, customerId) เสมอ — ไม่เชื่อ fundId ที่ client ส่งมาลำพัง
  //   (ป้องกัน fundId ของลูกค้า/tenant อื่นถูกผูกกับ voucher นี้แบบเงียบ ๆ, mirror settleVouchersAction)
  const fund = await getFund(db, tenantId, customerId);
  if (!fund || fund.id !== fundId) {
    return { ok: false, message: "กองทุนไม่ตรงกับที่เลือก กรุณาลองใหม่" };
  }

  const { data, error } = await db
    .from("petty_cash_vouchers")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      fund_id: fund.id,
      voucher_date: v.value.voucherDate,
      description: v.value.description,
      category_account_code: v.value.categoryAccountCode,
      amount: v.value.amount,
      receipt_no: v.value.receiptNo,
      status: "pending",
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "เพิ่มใบเบิกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: (data as { id: string }).id };
}

/** ลบใบเบิก (soft-delete) — เฉพาะที่ยัง 'pending' เท่านั้น (เคลียร์แล้วผูกกับ JE ไปแล้ว ห้ามลบตรงนี้) */
export async function softDeleteVoucher(db: DB, tenantId: string, id: string): Promise<PettyCashActionResult> {
  const scope = await getVoucherScope(db, tenantId, id);
  if (!scope) return { ok: false, message: "ไม่พบใบเบิก (อาจถูกลบไปแล้ว)" };
  if (scope.status !== "pending") {
    return { ok: false, message: "ใบเบิกนี้เคลียร์เข้าสมุดรายวันไปแล้ว — ลบตรงนี้ไม่ได้ ต้องแก้ไขที่ JE โดยตรง" };
  }
  const { error } = await db
    .from("petty_cash_vouchers")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "pending"); // ★ กัน TOCTOU — re-assert status ตรง statement UPDATE เอง ไม่เชื่อผลอ่านก่อนหน้า
  if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/**
 * ตรวจว่า manual JE (id) ผูกกับใบเบิกเงินสดย่อยที่ 'settled' อยู่จริงหรือไม่ (best-effort, ใช้เป็น
 *   defense-in-depth ตอนลบ JE ที่หน้า journal-entry — mirror isFxCycleConfirmedForJe) ถ้าผูกอยู่และถูกลบ
 *   ไป settled_je_id จะเหลือชี้ไป JE ที่ soft-delete แล้ว (ยัง deleted_at ไม่ null) ทำให้ voucher นั้น
 *   ค้างสถานะ settled โดยไม่มี JE จริงหนุนอยู่แบบไม่มีทางแก้ในหน้าเงินสดย่อย — จึงต้องกันไว้ก่อนลบ
 */
export async function isJeReferencedBySettledVoucher(db: DB, tenantId: string, jeId: string): Promise<boolean> {
  const { data } = await db
    .from("petty_cash_vouchers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("settled_je_id", jeId)
    .eq("status", "settled")
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/** ยอดคงเหลือเงินสดย่อยปัจจุบัน = floatAmount − Σ(voucher ที่ยัง pending) — คำนวณสดเสมอ */
export function computeBalance(fund: PettyCashFund, pendingVouchers: PettyCashVoucher[]): number {
  const spent = pendingVouchers.reduce((s, v) => s + (v.status === "pending" ? v.amount : 0), 0);
  return round2(fund.floatAmount - spent);
}

// ---------------------------------------------------------------------
// เคลียร์เงินสดย่อย (settle) → manual JE ดราฟต์ 1 ใบ (pure builder)
// ---------------------------------------------------------------------

export type BuildSettlementJeResult = { ok: true; value: ManualEntryInput } | { ok: false; message: string };

/**
 * รวมใบเบิก pending ที่เลือกเป็น manual JE เดียว: Dr ค่าใช้จ่ายแต่ละประเภท (รวมยอดตาม
 *   categoryAccountCode) = Cr บัญชีต้นทางที่เติมเงินคืน (sourceAccountCode) ด้วยยอดรวมทั้งหมด
 *   — สมดุลเสมอโดยโครงสร้าง (Cr = Σ ของ Dr ทุกบรรทัดพอดี)
 */
export function buildSettlementJournalEntryInput(
  fund: PettyCashFund,
  vouchers: PettyCashVoucher[],
  docDate: string,
  memo?: string | null
): BuildSettlementJeResult {
  const pending = vouchers.filter((v) => v.status === "pending");
  if (pending.length === 0) {
    return { ok: false, message: "ไม่มีใบเบิกที่ยัง pending ให้เคลียร์" };
  }

  const byCode = new Map<string, number>();
  for (const v of pending) {
    byCode.set(v.categoryAccountCode, round2((byCode.get(v.categoryAccountCode) ?? 0) + v.amount));
  }

  const lines: ManualEntryLineInput[] = [...byCode.entries()].map(([code, amount]) => ({
    accountCode: code,
    debit: amount,
    credit: 0,
  }));
  const total = round2(pending.reduce((s, v) => s + v.amount, 0));
  lines.push({ accountCode: fund.sourceAccountCode, debit: 0, credit: total });

  return {
    ok: true,
    value: {
      docType: "PV",
      docDate,
      docNo: null,
      memo: memo ?? `เคลียร์เงินสดย่อย "${fund.fundName}" (${pending.length} ใบ) — ดราฟต์ ตรวจสอบก่อนยืนยัน`,
      lines,
    },
  };
}
