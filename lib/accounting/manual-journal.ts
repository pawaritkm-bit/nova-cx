/**
 * ลงบันทึกบัญชีเอง (Manual Journal Entry: JV/PV/RV) — data layer (DB) + validate + pure mapper
 *
 * บริบท: เฟส 1 ส่วน C (docs/06-accounting-features-roadmap.md) — นักบัญชีลงรายการปรับปรุงเอง
 *   แยกตารางจาก bill_entries ทั้งหมด (migration 0066 — bill_entries ผูก seller/buyer/VAT/WHT ต่อบรรทัด
 *   ไม่มีแนวคิด debit/credit ตรง ๆ แบบ JV มือ และจะพัง filter รายงานภาษีที่กรองตาม entry_type)
 *   ต่อเข้า engine บัญชีด้วย mapper 2 ตัว (ไม่แก้ตรรกะ ledger/trial-balance/journal-books เลย):
 *     - toJournalLines(entry)   → JournalLine[] (รูปเดียวกับที่ buildJournalEntries สร้างจากบิล)
 *       concat เข้า statements.ts ก่อนเข้า buildLedger
 *     - toJournalPosting(entry) → JournalPosting (รูปเดียวกับที่ journal-books.ts ใช้) route เข้า
 *       เล่มตาม doc_type (JV→ทั่วไป, PV→จ่ายเงิน, RV→รับเงิน — แก้ TODO เดิมที่เล่มรับ/จ่ายเงินว่างเปล่า, 0.8)
 *
 * ★ ทุก query/write กรอง tenant_id (จาก session) + customer_id (assertCustomerInScope ทำที่ actions.ts ชั้นบน)
 * ★ ความสมดุล debit=credit ต่อ entry บังคับตอน validate เสมอ (ทั้งตอนบันทึก/ตอนยืนยัน — ไม่ปล่อยรายการ
 *   ไม่สมดุลเข้า DB เลย แม้จะเป็นแค่ draft) — ใช้ EPSILON เดียวกับ journal.ts (ไม่ใช้ DB constraint)
 * ★ แก้ไข/ลบบรรทัดได้เฉพาะตอน status='draft' (เหมือน bill_entries.status='confirmed' ที่ล็อกการแก้เดิม)
 *   ต้อง unconfirmManualEntry (ยกเลิกยืนยัน) ก่อนแก้ แล้วเช็คสมดุลใหม่ทุกครั้งก่อน confirm ซ้ำ
 * ★ soft-delete (deleted_at) — ไม่ลบจริง (pattern เดิมทั้งระบบ)
 * ★ account_code เก็บเป็นข้อความตรงตัวอักษรกับ chart_of_accounts.code (ไม่ใช้ FK จริง — เหมือน
 *   bill_entry_lines.account_code เดิม) · validate ต้องอยู่ในผังที่ส่งเข้ามา (chartByCode)
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { round2 } from "@/lib/accounting/queries";
import { isValidCurrencyCode } from "@/lib/accounting/currency";
import { EPSILON } from "@/lib/accounting/statement-config";
import type { JournalLine } from "@/lib/accounting/journal";
import type { BookKind, JournalPosting, PostingLeg } from "@/lib/accounting/journal-books";

type DB = SupabaseClient;

export type ManualDocType = "JV" | "PV" | "RV";
export type ManualEntryStatus = "draft" | "confirmed";

/** ป้ายชื่อประเภทเอกสาร (ไทย) — ใช้ในตัวเลือก/แสดงผล */
export const MANUAL_DOC_TYPE_LABELS: Record<ManualDocType, string> = {
  JV: "JV — ใบสำคัญทั่วไป",
  PV: "PV — ใบสำคัญจ่ายเงิน",
  RV: "RV — ใบสำคัญรับเงิน",
};

/** เล่มสมุดรายวันที่ manual JE เข้า ตาม doc_type (0.8: JV→ทั่วไป · PV→จ่ายเงิน · RV→รับเงิน) */
export function bookOfDocType(docType: ManualDocType): BookKind {
  if (docType === "PV") return "payment";
  if (docType === "RV") return "receipt";
  return "general";
}

/** 1 บรรทัดของ manual JE (id มีเมื่อโหลดจาก DB แล้ว — ไม่มีตอนสร้างใหม่) */
export type ManualJournalLine = {
  id?: string;
  lineNo: number;
  accountCode: string;
  accountName: string | null;
  description: string | null;
  debit: number;
  credit: number;
  /**
   * เฟส 10 ส่วน AA (migration 0089) — metadata ล้วน บอกที่มาว่าบรรทัดนี้เกี่ยวกับ FX ไหม (เช่น บรรทัดที่
   *   `fx.ts::suggestFxGainLossEntryInput` สร้างให้อัตโนมัติ) — ★ ไม่กระทบ isBalanced/toJournalLines/
   *   toJournalPosting เลยแม้แต่จุดเดียว (ค่ายังอ่านจาก debit/credit ตรง ๆ เหมือนเดิม) · optional ทั้งชุด —
   *   JV ปกติที่นักบัญชีสร้างเองไม่มี metadata นี้เลย (undefined/null)
   */
  fxCurrency?: string | null;
  fxRate?: number | null;
  fxAmount?: number | null;
};

/** หัว + บรรทัด manual JE 1 ใบ */
export type ManualJournalEntry = {
  id: string;
  tenantId: string;
  customerId: string;
  docType: ManualDocType;
  /** YYYY-MM-DD */
  docDate: string;
  docNo: string | null;
  memo: string | null;
  status: ManualEntryStatus;
  createdAt: string;
  confirmedAt: string | null;
  lines: ManualJournalLine[];
};

/** เพดานความยาว/จำนวน (กัน payload ใหญ่ผิดปกติ) */
export const DOC_NO_MAX = 50;
export const MEMO_MAX = 500;
export const ACCOUNT_NAME_MAX = 200;
export const DESCRIPTION_MAX = 200;
export const ACCOUNT_CODE_MAX = 20;
/** ★ ต้องมีอย่างน้อย 2 บรรทัด (double-entry ขั้นต่ำ — 1 เดบิต + 1 เครดิต) */
export const MIN_LINES = 2;
export const MAX_LINES = 50;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function nonZero(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) >= EPSILON;
}

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function asDocType(v: unknown): ManualDocType | null {
  return v === "JV" || v === "PV" || v === "RV" ? v : null;
}

/** ยอดเงิน → number (>=0 ปัด 2 ตำแหน่ง) — ค่าติดลบ/ไม่ใช่ตัวเลข = 0 (ห้ามยอดติดลบต่อบรรทัด) */
function asAmount(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

/** เดบิตรวม/เครดิตรวมเท่ากันไหม (ภายใน EPSILON) — ใช้ตรวจก่อน insert/update/confirm ทุกครั้ง */
export function isBalanced(lines: { debit: number; credit: number }[]): boolean {
  const d = round2(lines.reduce((s, l) => s + (Number.isFinite(l.debit) ? l.debit : 0), 0));
  const c = round2(lines.reduce((s, l) => s + (Number.isFinite(l.credit) ? l.credit : 0), 0));
  return Math.abs(d - c) < EPSILON;
}

// ---------------------------------------------------------------------
// validate (pure) — server ต้อง re-validate เสมอ ไม่เชื่อ client
// ---------------------------------------------------------------------

/** input ดิบ 1 บรรทัด จาก client */
export type ManualEntryLineInput = {
  accountCode: unknown;
  accountName?: unknown;
  description?: unknown;
  debit: unknown;
  credit: unknown;
  /** เฟส 10 ส่วน AA — metadata ล้วน (ดู ManualJournalLine) — รับ/เก็บผ่านเฉย ๆ ไม่ validate กับ debit/credit */
  fxCurrency?: unknown;
  fxRate?: unknown;
  fxAmount?: unknown;
};

/** input ดิบทั้งใบ จาก client */
export type ManualEntryInput = {
  docType: unknown;
  docDate: unknown;
  docNo?: unknown;
  memo?: unknown;
  lines: ManualEntryLineInput[];
};

export type ValidatedManualEntry = {
  docType: ManualDocType;
  docDate: string;
  docNo: string | null;
  memo: string | null;
  lines: ManualJournalLine[];
};

export type ManualValidationResult =
  | { ok: true; value: ValidatedManualEntry }
  | { ok: false; message: string };

/**
 * validate + sanitize input จาก client — ปฏิเสธเสมอถ้า:
 *   - doc_type/doc_date ผิดรูป
 *   - จำนวนบรรทัด < MIN_LINES หรือ > MAX_LINES
 *   - บรรทัดใดไม่ระบุรหัสบัญชี / รหัสไม่อยู่ในผังที่ส่งเข้ามา (chartByCode)
 *   - บรรทัดใดมีทั้งเดบิตและเครดิต (ต้องมีแค่ฝั่งเดียว) หรือไม่มีทั้งสองฝั่ง (ยอด 0 ทั้งคู่)
 *   - เดบิตรวม ≠ เครดิตรวมทั้งใบ (ไม่สมดุล) — ★ กันไม่สมดุลตั้งแต่ตอนบันทึก (ไม่ใช่แค่ตอนยืนยัน)
 */
export function validateManualEntryInput(
  input: ManualEntryInput,
  chartByCode: ChartByCode
): ManualValidationResult {
  const docType = asDocType(input.docType);
  if (!docType) return { ok: false, message: "ต้องระบุประเภทเอกสาร (JV/PV/RV)" };

  const docDate =
    typeof input.docDate === "string" && DATE_RE.test(input.docDate) ? input.docDate : "";
  if (!docDate) return { ok: false, message: "ต้องระบุวันที่เอกสารให้ถูกรูปแบบ" };

  const docNo = clampText(input.docNo, DOC_NO_MAX);
  const memo = clampText(input.memo, MEMO_MAX);

  if (!Array.isArray(input.lines) || input.lines.length < MIN_LINES) {
    return { ok: false, message: `ต้องมีอย่างน้อย ${MIN_LINES} บรรทัด (เดบิตและเครดิต)` };
  }
  if (input.lines.length > MAX_LINES) {
    return { ok: false, message: `บรรทัดมากเกินไป (สูงสุด ${MAX_LINES} บรรทัด)` };
  }

  const lines: ManualJournalLine[] = [];
  for (let i = 0; i < input.lines.length; i++) {
    const raw = input.lines[i];
    const accountCode = clampText(raw.accountCode, ACCOUNT_CODE_MAX);
    if (!accountCode) return { ok: false, message: `บรรทัดที่ ${i + 1}: ต้องเลือกรหัสบัญชี` };
    const chartAcc = chartByCode[accountCode];
    if (!chartAcc) {
      return { ok: false, message: `บรรทัดที่ ${i + 1}: รหัสบัญชี "${accountCode}" ไม่อยู่ในผังบัญชี` };
    }

    const debit = asAmount(raw.debit);
    const credit = asAmount(raw.credit);
    if (nonZero(debit) && nonZero(credit)) {
      return { ok: false, message: `บรรทัดที่ ${i + 1}: ระบุได้แค่ฝั่งเดบิตหรือเครดิต ไม่ใช่ทั้งสองฝั่ง` };
    }
    if (!nonZero(debit) && !nonZero(credit)) {
      return { ok: false, message: `บรรทัดที่ ${i + 1}: ต้องระบุยอดเดบิตหรือเครดิต` };
    }

    const accountName = clampText(raw.accountName, ACCOUNT_NAME_MAX) ?? chartAcc.name;
    const description = clampText(raw.description, DESCRIPTION_MAX);

    // ★ เฟส 10 ส่วน AA — fx metadata: รับ/เก็บผ่านเฉย ๆ ไม่ validate ความสัมพันธ์กับ debit/credit (ไม่ใช่
    //   แหล่งความจริงทางบัญชี แค่ metadata อธิบายที่มา) — รูปแบบผิด/ไม่ใช่ตัวเลข → เก็บเป็น null เงียบ ๆ
    const fxCurrencyRaw = typeof raw.fxCurrency === "string" ? raw.fxCurrency.trim().toUpperCase() : "";
    const fxCurrency = fxCurrencyRaw && isValidCurrencyCode(fxCurrencyRaw) ? fxCurrencyRaw : null;
    const fxRateNum = typeof raw.fxRate === "number" ? raw.fxRate : Number(raw.fxRate);
    const fxRate = fxCurrency && Number.isFinite(fxRateNum) && fxRateNum > 0 ? fxRateNum : null;
    const fxAmountNum = typeof raw.fxAmount === "number" ? raw.fxAmount : Number(raw.fxAmount);
    const fxAmount = fxCurrency && Number.isFinite(fxAmountNum) && fxAmountNum > 0 ? round2(fxAmountNum) : null;

    lines.push({ lineNo: i + 1, accountCode, accountName, description, debit, credit, fxCurrency, fxRate, fxAmount });
  }

  if (!isBalanced(lines)) {
    return { ok: false, message: "เดบิตรวมต้องเท่ากับเครดิตรวม — ไม่สมดุล บันทึกไม่ได้" };
  }

  return { ok: true, value: { docType, docDate, docNo, memo, lines } };
}

// ---------------------------------------------------------------------
// pure mapper — ต่อเข้า engine บัญชี (ไม่แตะ DB)
// ---------------------------------------------------------------------

/**
 * แปลง manual JE → JournalLine[] (รูปเดียวกับที่ buildJournalEntries สร้างจากบิล)
 *   ★ ใช้กับ entry ที่ "ยืนยันแล้ว" เท่านั้น (caller กรองตาม status ก่อนส่งเข้ามา — ฟังก์ชันนี้ pure ไม่เช็ค status)
 *   description ต่อบรรทัด (ถ้ามี) แสดงเป็นคำอธิบายในบัญชีแยกประเภท · ไม่มี → fallback เป็น memo ของทั้งใบ
 */
export function toJournalLines(entry: ManualJournalEntry): JournalLine[] {
  return entry.lines
    .filter((l) => nonZero(l.debit) || nonZero(l.credit))
    .map((l) => ({
      entryId: entry.id,
      date: entry.docDate,
      docNo: entry.docNo,
      accountCode: l.accountCode,
      accountName: l.accountName ?? l.accountCode,
      debit: l.debit,
      credit: l.credit,
      side: nonZero(l.debit) ? ("debit" as const) : ("credit" as const),
      customerId: entry.customerId,
      counterparty: (l.description && l.description.trim()) || entry.memo || null,
    }));
}

/**
 * แปลง manual JE → JournalPosting (รูปเดียวกับที่ journal-books.ts ใช้แสดงใบสำคัญ)
 *   route เข้าเล่มตาม doc_type (0.8) — ใช้ merge เข้า buildJournalBooks() ผ่านพารามิเตอร์ manualPostings
 */
export function toJournalPosting(entry: ManualJournalEntry): JournalPosting {
  const debits: PostingLeg[] = [];
  const credits: PostingLeg[] = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of entry.lines) {
    if (nonZero(l.debit)) {
      debits.push({ accountCode: l.accountCode, accountName: l.accountName ?? l.accountCode, amount: l.debit });
      totalDebit = round2(totalDebit + l.debit);
    } else if (nonZero(l.credit)) {
      credits.push({ accountCode: l.accountCode, accountName: l.accountName ?? l.accountCode, amount: l.credit });
      totalCredit = round2(totalCredit + l.credit);
    }
  }
  return {
    entryId: entry.id,
    date: entry.docDate,
    docNo: entry.docNo,
    description: entry.memo ?? "",
    debits,
    credits,
    totalDebit,
    totalCredit,
    book: bookOfDocType(entry.docType),
  };
}

// ---------------------------------------------------------------------
// data layer (DB) — ทุก query/write กรอง tenant_id + customer_id
// ---------------------------------------------------------------------

const LIST_LIMIT = 500;

type RawHead = {
  id: string;
  tenant_id: string;
  customer_id: string;
  doc_type: string;
  doc_date: string;
  doc_no: string | null;
  memo: string | null;
  status: string;
  created_at: string;
  confirmed_at: string | null;
};

type RawLine = {
  id: string;
  entry_id: string;
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

const LINE_COLUMNS_BASE = "id, entry_id, line_no, account_code, account_name, description, debit, credit";
const LINE_COLUMNS_FX = `${LINE_COLUMNS_BASE}, fx_currency, fx_rate, fx_amount`;

/**
 * โหลด lines ของหลาย manual JE พร้อมกัน — best-effort สำหรับคอลัมน์ fx_* (migration 0089, เฟส 10 ส่วน AA)
 *   ★ ลองเลือกพร้อมคอลัมน์ fx ก่อน — ถ้า error (คอลัมน์ยังไม่ apply) ลองใหม่แบบไม่มีคอลัมน์ fx (degrade
 *   เงียบ เหมือน input_tax_month — ไม่ทำ list ทั้งหน้าพัง)
 */
async function loadManualLines(db: DB, tenantId: string, entryIds: string[]): Promise<RawLine[]> {
  const withFx = await db
    .from("manual_journal_entry_lines")
    .select(LINE_COLUMNS_FX)
    .eq("tenant_id", tenantId)
    .in("entry_id", entryIds)
    .order("line_no", { ascending: true });
  if (!withFx.error) return (withFx.data ?? []) as unknown as RawLine[];

  const fallback = await db
    .from("manual_journal_entry_lines")
    .select(LINE_COLUMNS_BASE)
    .eq("tenant_id", tenantId)
    .in("entry_id", entryIds)
    .order("line_no", { ascending: true });
  return (fallback.data ?? []) as unknown as RawLine[];
}

/** payload 1 บรรทัดสำหรับ insert — includeFx=false ใช้ตอน retry เมื่อ insert พร้อมคอลัมน์ fx พลาด (best-effort) */
function lineInsertRow(
  l: ManualJournalLine,
  entryId: string,
  tenantId: string,
  includeFx: boolean
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    entry_id: entryId,
    tenant_id: tenantId,
    line_no: l.lineNo,
    account_code: l.accountCode,
    account_name: l.accountName,
    description: l.description,
    debit: l.debit,
    credit: l.credit,
  };
  if (!includeFx) return base;
  return {
    ...base,
    fx_currency: l.fxCurrency ?? null,
    fx_rate: l.fxRate ?? null,
    fx_amount: l.fxAmount ?? null,
  };
}

/**
 * insert บรรทัด manual JE ทั้งชุด — best-effort สำหรับคอลัมน์ fx_* (migration 0089) เหมือน loadManualLines
 *   ★ ลอง insert พร้อมคอลัมน์ fx ก่อน — ถ้า error (คอลัมน์ยังไม่ apply) ลองใหม่แบบไม่มีคอลัมน์ fx ทันที
 *   (degrade เงียบ ไม่ throw ทั้งการบันทึก JV)
 */
async function insertManualLines(
  db: DB,
  tenantId: string,
  entryId: string,
  lines: ManualJournalLine[]
): Promise<{ error: unknown }> {
  const withFx = await db
    .from("manual_journal_entry_lines")
    .insert(lines.map((l) => lineInsertRow(l, entryId, tenantId, true)));
  if (!withFx.error) return { error: null };

  const withoutFx = await db
    .from("manual_journal_entry_lines")
    .insert(lines.map((l) => lineInsertRow(l, entryId, tenantId, false)));
  return { error: withoutFx.error };
}

/** ดึง manual JE ทั้งหมดของลูกค้า 1 ราย (draft+confirmed, scope tenant+customer) เรียงวันที่ล่าสุดก่อน */
export async function listManualEntries(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<ManualJournalEntry[]> {
  const { data: heads, error } = await db
    .from("manual_journal_entries")
    .select("id, tenant_id, customer_id, doc_type, doc_date, doc_no, memo, status, created_at, confirmed_at")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("doc_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error || !heads) return [];
  const rows = heads as unknown as RawHead[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const lineData = await loadManualLines(db, tenantId, ids);

  const linesByEntry = new Map<string, ManualJournalLine[]>();
  for (const r of lineData) {
    const arr = linesByEntry.get(r.entry_id) ?? [];
    arr.push({
      id: r.id,
      lineNo: r.line_no,
      accountCode: r.account_code,
      accountName: r.account_name,
      description: r.description,
      debit: asAmount(r.debit),
      credit: asAmount(r.credit),
      fxCurrency: r.fx_currency ?? null,
      fxRate: r.fx_rate === null || r.fx_rate === undefined ? null : Number(r.fx_rate),
      fxAmount: r.fx_amount === null || r.fx_amount === undefined ? null : Number(r.fx_amount),
    });
    linesByEntry.set(r.entry_id, arr);
  }

  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    docType: (r.doc_type as ManualDocType) ?? "JV",
    docDate: r.doc_date,
    docNo: r.doc_no,
    memo: r.memo,
    status: (r.status as ManualEntryStatus) ?? "draft",
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    lines: linesByEntry.get(r.id) ?? [],
  }));
}

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline */
export type ManualActionResult = { ok: true; id: string } | { ok: false; message: string };

/**
 * โหลด customer_id + status ของ manual JE 1 ใบ (scope tenant) — ใช้ตรวจสโคปลูกค้า (assertCustomerInScope)
 *   ก่อนแก้/ลบ/confirm ทุกครั้งที่ actions.ts ชั้นบนเรียก (เหมือน loadEntryCustomerId ของ bill_entries)
 */
export async function getManualEntryScope(
  db: DB,
  tenantId: string,
  id: string
): Promise<{ customerId: string; status: ManualEntryStatus } | null> {
  const { data } = await db
    .from("manual_journal_entries")
    .select("customer_id, status")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as { customer_id: string; status: string };
  return { customerId: r.customer_id, status: (r.status as ManualEntryStatus) ?? "draft" };
}

/**
 * สร้าง/แก้ manual JE ทั้งใบ (header + แทนที่ lines ทั้งหมด) — validate ซ้ำฝั่ง server เสมอ
 *   - id ระบุ = update (ต้องเป็น status='draft' เท่านั้น — confirmed แล้วต้อง unconfirmManualEntry ก่อน)
 *   - id ไม่ระบุ = insert ใหม่ (status='draft' เสมอ)
 */
export async function upsertManualEntry(
  db: DB,
  tenantId: string,
  customerId: string,
  input: ManualEntryInput,
  chartByCode: ChartByCode,
  id?: string
): Promise<ManualActionResult> {
  const v = validateManualEntryInput(input, chartByCode);
  if (!v.ok) return { ok: false, message: v.message };

  if (id) {
    const cur = await getManualEntryScope(db, tenantId, id);
    if (!cur) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
    if (cur.customerId !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับรายการเดิม" };
    if (cur.status !== "draft") {
      return { ok: false, message: "รายการนี้ยืนยันแล้ว — ต้องยกเลิกการยืนยันก่อนแก้ไข" };
    }

    const { error } = await db
      .from("manual_journal_entries")
      .update({
        doc_type: v.value.docType,
        doc_date: v.value.docDate,
        doc_no: v.value.docNo,
        memo: v.value.memo,
      })
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };

    // แทนที่ lines ทั้งหมด (จำนวนบรรทัดต่อใบน้อย ≤ MAX_LINES — ไม่ใช่ปัญหา perf)
    await db.from("manual_journal_entry_lines").delete().eq("entry_id", id).eq("tenant_id", tenantId);
    const { error: lineErr } = await insertManualLines(db, tenantId, id, v.value.lines);
    if (lineErr) return { ok: false, message: "บันทึกบรรทัดไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, id };
  }

  // insert ใหม่
  const { data, error } = await db
    .from("manual_journal_entries")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      doc_type: v.value.docType,
      doc_date: v.value.docDate,
      doc_no: v.value.docNo,
      memo: v.value.memo,
      status: "draft",
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "เพิ่มรายการไม่สำเร็จ กรุณาลองใหม่" };
  const newId = (data as { id: string }).id;

  const { error: lineErr } = await insertManualLines(db, tenantId, newId, v.value.lines);
  if (lineErr) {
    // ใส่บรรทัดไม่สำเร็จ → ลบหัวที่เพิ่งสร้างทิ้ง (กันหัวเปล่าไม่มีบรรทัดค้างใน DB)
    await db.from("manual_journal_entries").delete().eq("id", newId).eq("tenant_id", tenantId);
    return { ok: false, message: "เพิ่มบรรทัดไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id: newId };
}

/** ยืนยัน manual JE (draft → confirmed) — เช็คสมดุลจาก DB อีกครั้งก่อนยืนยัน (กันแก้ผ่านช่องทางอื่นแล้วไม่สมดุล) */
export async function confirmManualEntry(db: DB, tenantId: string, id: string): Promise<ManualActionResult> {
  const cur = await getManualEntryScope(db, tenantId, id);
  if (!cur) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
  if (cur.status === "confirmed") return { ok: true, id };

  const { data: lineData } = await db
    .from("manual_journal_entry_lines")
    .select("debit, credit")
    .eq("entry_id", id)
    .eq("tenant_id", tenantId);
  const lines = ((lineData ?? []) as { debit: number | string; credit: number | string }[]).map((l) => ({
    debit: asAmount(l.debit),
    credit: asAmount(l.credit),
  }));
  if (lines.length < MIN_LINES) {
    return { ok: false, message: `รายการนี้ยังมีไม่ครบ (อย่างน้อย ${MIN_LINES} บรรทัด) — ยืนยันไม่ได้` };
  }
  if (!isBalanced(lines)) {
    return { ok: false, message: "เดบิตรวมไม่เท่ากับเครดิตรวม — ยืนยันไม่ได้" };
  }

  const { error } = await db
    .from("manual_journal_entries")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ยืนยันไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/** ยกเลิกการยืนยัน (confirmed → draft) — ให้แก้ไขได้อีกครั้ง (ต้องเช็คสมดุลใหม่ก่อน confirm ซ้ำ) */
export async function unconfirmManualEntry(db: DB, tenantId: string, id: string): Promise<ManualActionResult> {
  const cur = await getManualEntryScope(db, tenantId, id);
  if (!cur) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
  const { error } = await db
    .from("manual_journal_entries")
    .update({ status: "draft", confirmed_at: null })
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ยกเลิกการยืนยันไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/** ลบ manual JE (soft-delete) — ลบได้ทั้ง draft/confirmed (เหมือน bill_entries.deleteEntry) */
export async function softDeleteManualEntry(db: DB, tenantId: string, id: string): Promise<ManualActionResult> {
  const cur = await getManualEntryScope(db, tenantId, id);
  if (!cur) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
  const { error } = await db
    .from("manual_journal_entries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}
