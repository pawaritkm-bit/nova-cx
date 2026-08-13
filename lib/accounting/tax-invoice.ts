/**
 * ใบกำกับภาษี (Tax Invoice) เต็มรูป/อย่างย่อ — data layer (DB) + validate + pure
 *
 * บริบท: wishlist backlog "ใบกำกับภาษี" — ออกได้เฉพาะจากบิลขาย (entry_type='sale') ที่ยืนยันแล้ว
 *   (status='confirmed') เท่านั้น เพราะเป็นเอกสารยืนยัน "ยอด/VAT ที่ระบบมีอยู่แล้วจริง" ไม่ใช่กรอกยอดใหม่
 *   แยกกันแบบ sales_documents (ใบเสนอราคา/PO/ใบวางบิล — เอกสารช่วยขายอิสระ)
 *
 * ★★★ ห้าม import จาก journal.ts/ledger.ts/statements.ts/journal-books.ts/payment.ts เด็ดขาด ★★★
 *   เอกสารนี้แค่ "แสดง" ยอด/VAT ที่ลงบัญชีไปแล้วตอนยืนยันบิล ไม่ใช่จุดลงบัญชีซ้ำ
 * ★ เลขที่เอกสาร (doc_no) assign แบบ atomic ผ่าน RPC `issue_tax_invoice` (migration 0110) — ไม่มี
 *   สถานะ draft (ต่างจาก sales_documents) เพราะเนื้อหามาจากบิลที่ยืนยันแล้วอยู่แล้ว กด "ออกเอกสาร"
 *   ครั้งเดียว = insert หัว+บรรทัด+เลขที่พร้อมกันเลย
 * ★ บรรทัดเก็บเป็น "สำเนา ณ เวลาออกเอกสาร" (snapshot) จาก bill_entry_lines — ไม่ sync ย้อนหลัง
 *   ถ้ามีคนแก้บิลต้นทางทีหลัง (mirror sales_document_lines::billing_note, 0.14 ของ migration 0070)
 * ★ 1 บิล ออกใบกำกับภาษีที่ยัง "ไม่ยกเลิก" ได้สูงสุด 1 ใบ — ออกผิดต้อง void แล้วออกใบใหม่ (เลขเดิมไม่ reuse)
 * ★ ทุก query/write กรอง tenant_id เสมอ — assertCustomerInScope ทำที่ actions.ts ชั้นบน
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อลูกค้า/คู่ค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { round2, summarizeEntry } from "@/lib/accounting/queries";
import { isValidCalendarDate } from "@/lib/accounting/bank-reconciliation";
import { beYearNowThai } from "@/lib/accounting/doc-format";

type DB = SupabaseClient;

export type TaxInvoiceFormType = "full" | "abbreviated";
export type TaxInvoiceStatus = "issued" | "void";
export type VatType = "vat" | "novat";

/** ป้ายภาษาไทย */
export const TAX_INVOICE_FORM_LABELS: Record<TaxInvoiceFormType, string> = {
  full: "ใบกำกับภาษีเต็มรูป",
  abbreviated: "ใบกำกับภาษีอย่างย่อ",
};

/** prefix เลขที่เอกสาร — คงที่ ห้ามเปลี่ยนภายหลัง (จะทำให้เลขที่เก่าอ่านไม่ตรง pattern) */
export const TAX_INVOICE_PREFIX: Record<TaxInvoiceFormType, string> = {
  full: "TX",
  abbreviated: "TA",
};

export function asTaxInvoiceFormType(v: unknown): TaxInvoiceFormType | null {
  return v === "full" || v === "abbreviated" ? v : null;
}

function asStatus(v: string): TaxInvoiceStatus {
  return v === "void" ? "void" : "issued";
}

function asVatType(v: unknown): VatType {
  return v === "novat" ? "novat" : "vat";
}

/** เพดานความยาว (กัน payload ใหญ่ผิดปกติ) */
export const DESCRIPTION_MAX = 200;
export const BUYER_NAME_MAX = 200;
export const BUYER_TAXID_MAX = 20;
export const BUYER_ADDRESS_MAX = 300;
export const BUYER_BRANCH_MAX = 50;
export const VOID_REASON_MAX = 300;
export const MAX_LINES = 200;

function numLocal(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

// =========================================================================
// ชนิดข้อมูล
// =========================================================================

export type TaxInvoiceLine = {
  id?: string;
  lineNo: number;
  description: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  /** ยอดก่อน VAT (tax base) ต่อบรรทัด */
  amount: number;
  vatType: VatType;
  vatAmount: number;
  sourceBillEntryLineId: string | null;
};

export type TaxInvoice = {
  id: string;
  tenantId: string;
  customerId: string;
  sourceBillEntryId: string;
  formType: TaxInvoiceFormType;
  docNo: string;
  docDate: string;
  buyerName: string | null;
  buyerTaxId: string | null;
  buyerAddress: string | null;
  buyerBranch: string | null;
  sellerBranch: string | null;
  status: TaxInvoiceStatus;
  voidReason: string | null;
  voidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: TaxInvoiceLine[];
};

// =========================================================================
// pure — eligibility + ยอดรวม
// =========================================================================

/** entry ที่ใช้ตัดสิน eligibility (ไม่ต้องรับ BillEntry เต็มรูป) */
export type TaxInvoiceEligibleEntry = { entryType: string; status: string };

/** true เฉพาะบิลขายที่ยืนยันแล้ว (0.1) — ใบกำกับภาษีต้องอ้างอิงยอดที่ลงบัญชีจริงแล้วเท่านั้น */
export function isTaxInvoiceEligible(entry: TaxInvoiceEligibleEntry): boolean {
  return entry.entryType === "sale" && entry.status === "confirmed";
}

/** ยอดรวม = Σ(line.amount + line.vatAmount) — reuse summarizeEntry (map whtAmount:0 เข้าไป, ไม่มีสูตรคู่ขนาน) */
export function taxInvoiceGrandTotal(lines: Pick<TaxInvoiceLine, "amount" | "vatAmount">[]): number {
  return summarizeEntry(lines.map((l) => ({ amount: l.amount, vatAmount: l.vatAmount, whtAmount: 0 }))).net;
}

/** สรุปยอดแยก: ฐานภาษี (VAT) / ฐานยกเว้นภาษี (novat) / VAT รวม — ใช้แสดงท้ายเอกสาร */
export function taxInvoiceVatSummary(lines: Pick<TaxInvoiceLine, "amount" | "vatAmount" | "vatType">[]): {
  baseVat: number;
  baseExempt: number;
  totalVat: number;
} {
  let baseVat = 0;
  let baseExempt = 0;
  let totalVat = 0;
  for (const l of lines) {
    if (l.vatType === "novat") baseExempt += l.amount;
    else baseVat += l.amount;
    totalVat += l.vatAmount;
  }
  return { baseVat: round2(baseVat), baseExempt: round2(baseExempt), totalVat: round2(totalVat) };
}

/** สร้างบรรทัดใบกำกับภาษีจากบรรทัดบิล — ข้ามบรรทัดที่ amount=0 (ไม่มีอะไรให้แสดง) */
export type TaxInvoiceSourceLine = {
  id: string;
  description: string | null;
  quantity: number | null;
  amount: number;
  vatType: VatType;
  vatAmount: number;
  unit: string | null;
};

export function buildTaxInvoiceLinesFromBill(billLines: TaxInvoiceSourceLine[]): TaxInvoiceLine[] {
  const eligible = billLines.filter((l) => Math.abs(l.amount) > 0.005);
  return eligible.map((l, i) => {
    const quantity = l.quantity && l.quantity > 0 ? l.quantity : 1;
    return {
      lineNo: i + 1,
      description: l.description,
      quantity,
      unit: l.unit,
      unitPrice: round2(l.amount / quantity),
      amount: round2(l.amount),
      vatType: l.vatType,
      vatAmount: round2(l.vatAmount),
      sourceBillEntryLineId: l.id,
    };
  });
}

// =========================================================================
// validate (pure) — server ต้อง re-validate เสมอ ไม่เชื่อ client
// =========================================================================

export type TaxInvoiceIssueInput = {
  formType: unknown;
  docDate: unknown;
  buyerName?: unknown;
  buyerTaxId?: unknown;
  buyerAddress?: unknown;
  buyerBranch?: unknown;
  sellerBranch?: unknown;
};

export type ValidatedTaxInvoiceIssueInput = {
  formType: TaxInvoiceFormType;
  docDate: string;
  buyerName: string | null;
  buyerTaxId: string | null;
  buyerAddress: string | null;
  buyerBranch: string | null;
  sellerBranch: string | null;
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * validate input ตอนออกเอกสาร — บังคับกรอกชื่อ+เลขผู้เสียภาษีผู้ซื้อเฉพาะ "เต็มรูป" เท่านั้น
 *   (0.1 — อย่างย่อไม่ต้องระบุตัวผู้ซื้อตามกฎหมาย ปล่อยว่างได้)
 */
export function validateIssueInput(input: TaxInvoiceIssueInput): ValidationResult<ValidatedTaxInvoiceIssueInput> {
  const formType = asTaxInvoiceFormType(input.formType);
  if (!formType) return { ok: false, message: "ต้องระบุรูปแบบใบกำกับภาษี (เต็มรูป/อย่างย่อ)" };

  const docDate = typeof input.docDate === "string" ? input.docDate.trim() : "";
  if (!isValidCalendarDate(docDate)) return { ok: false, message: "วันที่เอกสารไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD)" };

  const buyerName = clampText(input.buyerName, BUYER_NAME_MAX);
  const buyerTaxId = clampText(input.buyerTaxId, BUYER_TAXID_MAX);
  const buyerAddress = clampText(input.buyerAddress, BUYER_ADDRESS_MAX);
  const buyerBranch = clampText(input.buyerBranch, BUYER_BRANCH_MAX);
  const sellerBranch = clampText(input.sellerBranch, BUYER_BRANCH_MAX);

  if (formType === "full" && (!buyerName || !buyerTaxId)) {
    return { ok: false, message: "ใบกำกับภาษีเต็มรูปต้องระบุชื่อและเลขประจำตัวผู้เสียภาษีของผู้ซื้อ" };
  }

  return { ok: true, value: { formType, docDate, buyerName, buyerTaxId, buyerAddress, buyerBranch, sellerBranch } };
}

// =========================================================================
// data layer (DB)
// =========================================================================

const LIST_LIMIT = 500;

type RawHead = {
  id: string;
  tenant_id: string;
  customer_id: string;
  source_bill_entry_id: string;
  form_type: string;
  doc_no: string;
  doc_date: string;
  buyer_name: string | null;
  buyer_tax_id: string | null;
  buyer_address: string | null;
  buyer_branch: string | null;
  seller_branch: string | null;
  status: string;
  void_reason: string | null;
  voided_at: string | null;
  created_at: string;
  updated_at: string;
};

type RawLine = {
  id: string;
  tax_invoice_id: string;
  line_no: number;
  description: string | null;
  quantity: number | string;
  unit: string | null;
  unit_price: number | string;
  amount: number | string;
  vat_type: string;
  vat_amount: number | string;
  source_bill_entry_line_id: string | null;
};

const HEAD_COLUMNS =
  "id, tenant_id, customer_id, source_bill_entry_id, form_type, doc_no, doc_date, buyer_name, buyer_tax_id, buyer_address, buyer_branch, seller_branch, status, void_reason, voided_at, created_at, updated_at";
const LINE_COLUMNS =
  "id, tax_invoice_id, line_no, description, quantity, unit, unit_price, amount, vat_type, vat_amount, source_bill_entry_line_id";

function mapLine(r: RawLine): TaxInvoiceLine {
  return {
    id: r.id,
    lineNo: r.line_no,
    description: r.description,
    quantity: numLocal(r.quantity),
    unit: r.unit,
    unitPrice: numLocal(r.unit_price),
    amount: numLocal(r.amount),
    vatType: asVatType(r.vat_type),
    vatAmount: numLocal(r.vat_amount),
    sourceBillEntryLineId: r.source_bill_entry_line_id,
  };
}

function mapHead(r: RawHead, lines: TaxInvoiceLine[]): TaxInvoice {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    sourceBillEntryId: r.source_bill_entry_id,
    formType: asTaxInvoiceFormType(r.form_type) ?? "full",
    docNo: r.doc_no,
    docDate: r.doc_date,
    buyerName: r.buyer_name,
    buyerTaxId: r.buyer_tax_id,
    buyerAddress: r.buyer_address,
    buyerBranch: r.buyer_branch,
    sellerBranch: r.seller_branch,
    status: asStatus(r.status),
    voidReason: r.void_reason,
    voidedAt: r.voided_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lines,
  };
}

/** สโคป + สถานะของใบกำกับภาษี 1 ใบ (ใช้ตรวจสิทธิ์/ก่อนเขียนทุกครั้ง) */
export type TaxInvoiceScope = { customerId: string; status: TaxInvoiceStatus };

export async function getTaxInvoiceScope(db: DB, tenantId: string, id: string): Promise<TaxInvoiceScope | null> {
  const { data } = await db
    .from("tax_invoices")
    .select("customer_id, status")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as { customer_id: string; status: string };
  return { customerId: r.customer_id, status: asStatus(r.status) };
}

/** ใบกำกับภาษี 1 ใบ (header + lines) — ใช้หน้าพิมพ์ */
export async function getTaxInvoice(db: DB, tenantId: string, id: string): Promise<TaxInvoice | null> {
  const { data } = await db
    .from("tax_invoices")
    .select(HEAD_COLUMNS)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const head = data as unknown as RawHead;

  const { data: lineData } = await db
    .from("tax_invoice_lines")
    .select(LINE_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("tax_invoice_id", id)
    .order("line_no", { ascending: true });
  const lines = ((lineData ?? []) as unknown as RawLine[]).map(mapLine);
  return mapHead(head, lines);
}

/** รายการใบกำกับภาษีของลูกค้า 1 ราย (ไม่รวมที่ลบแล้ว) เรียงออกล่าสุดก่อน — ไม่ join บรรทัด (ใช้แค่หัวในตาราง list) */
export async function listTaxInvoices(db: DB, tenantId: string, customerId: string): Promise<TaxInvoice[]> {
  const { data } = await db
    .from("tax_invoices")
    .select(HEAD_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  return ((data ?? []) as unknown as RawHead[]).map((r) => mapHead(r, []));
}

/** map บิล → ใบกำกับภาษีที่ยัง "ไม่ยกเลิก" (ถ้ามี) — ใช้แสดง badge "ออกแล้ว/เลขที่..." บนรายการบิล */
export async function listTaxInvoicesForEntries(
  db: DB,
  tenantId: string,
  entryIds: string[]
): Promise<Map<string, TaxInvoice>> {
  const map = new Map<string, TaxInvoice>();
  if (entryIds.length === 0) return map;
  const { data } = await db
    .from("tax_invoices")
    .select(HEAD_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("source_bill_entry_id", entryIds)
    .neq("status", "void")
    .is("deleted_at", null);
  for (const r of (data ?? []) as unknown as RawHead[]) {
    map.set(r.source_bill_entry_id, mapHead(r, []));
  }
  return map;
}

// =========================================================================
// ออกเอกสาร / ยกเลิก
// =========================================================================

export type TaxInvoiceActionResult = { ok: true; id: string } | { ok: false; message: string };
export type IssueTaxInvoiceResult = { ok: true; id: string; docNo: string } | { ok: false; message: string };

type RpcResult = { id?: string; doc_no?: string } | null;

/**
 * ออกใบกำกับภาษีจากบิลขายที่ยืนยันแล้ว 1 ใบ — โหลดบิล+บรรทัดจริง สร้าง snapshot บรรทัด แล้วเรียก
 *   RPC `issue_tax_invoice` แบบ atomic (0.12 ของ migration 0110) — ผู้เรียก (actions.ts) รับผิดชอบ
 *   ยืนยันสโคปลูกค้าของ billEntryId ก่อนเรียกฟังก์ชันนี้เสมอ (0.13)
 */
export async function issueTaxInvoice(
  db: DB,
  tenantId: string,
  customerId: string,
  billEntryId: string,
  input: TaxInvoiceIssueInput
): Promise<IssueTaxInvoiceResult> {
  const v = validateIssueInput(input);
  if (!v.ok) return { ok: false, message: v.message };

  const { data: entryData, error: entryErr } = await db
    .from("bill_entries")
    .select("id, customer_id, entry_type, status")
    .eq("id", billEntryId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (entryErr || !entryData) return { ok: false, message: "ไม่พบบิลนี้ (อาจถูกลบไปแล้ว)" };
  const entry = entryData as { id: string; customer_id: string | null; entry_type: string; status: string };
  if (entry.customer_id !== customerId) return { ok: false, message: "ลูกค้าไม่ตรงกับบิลนี้" };
  if (!isTaxInvoiceEligible({ entryType: entry.entry_type, status: entry.status })) {
    return { ok: false, message: "บิลนี้ยังไม่ผ่านเงื่อนไข (ต้องเป็นบิลขายที่ยืนยันแล้วเท่านั้น)" };
  }

  const { data: lineData, error: lineErr } = await db
    .from("bill_entry_lines")
    .select("id, description, quantity, amount, vat_type, vat_amount")
    .eq("tenant_id", tenantId)
    .eq("entry_id", billEntryId)
    .order("line_no", { ascending: true });
  if (lineErr) return { ok: false, message: "โหลดรายการบิลไม่สำเร็จ กรุณาลองใหม่" };

  const rawLines = (lineData ?? []) as unknown as {
    id: string;
    description: string | null;
    quantity: number | string | null;
    amount: number | string | null;
    vat_type: string;
    vat_amount: number | string | null;
  }[];
  const sourceLines: TaxInvoiceSourceLine[] = rawLines.map((l) => ({
    id: l.id,
    description: l.description,
    quantity: l.quantity === null ? null : numLocal(l.quantity),
    amount: numLocal(l.amount),
    vatType: asVatType(l.vat_type),
    vatAmount: numLocal(l.vat_amount),
    unit: null,
  }));
  const lines = buildTaxInvoiceLinesFromBill(sourceLines);
  if (lines.length === 0) {
    return { ok: false, message: "บิลนี้ไม่มีบรรทัดที่มียอดเงินให้ออกใบกำกับภาษีได้" };
  }

  const beYear = beYearNowThai();
  const prefix = TAX_INVOICE_PREFIX[v.value.formType];

  const { data, error } = await db.rpc("issue_tax_invoice", {
    p_tenant_id: tenantId,
    p_customer_id: customerId,
    p_source_bill_entry_id: billEntryId,
    p_form_type: v.value.formType,
    p_doc_date: v.value.docDate,
    p_be_year: beYear,
    p_prefix: prefix,
    p_buyer_name: v.value.buyerName,
    p_buyer_tax_id: v.value.buyerTaxId,
    p_buyer_address: v.value.buyerAddress,
    p_buyer_branch: v.value.buyerBranch,
    p_seller_branch: v.value.sellerBranch,
    p_lines: lines.map((l) => ({
      line_no: l.lineNo,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unit_price: l.unitPrice,
      amount: l.amount,
      vat_type: l.vatType,
      vat_amount: l.vatAmount,
      source_bill_entry_line_id: l.sourceBillEntryLineId,
    })),
  });
  if (error) {
    return { ok: false, message: "ออกใบกำกับภาษีไม่สำเร็จ (บิลนี้อาจมีใบกำกับภาษีอยู่แล้ว) กรุณาลองใหม่" };
  }
  const result = data as RpcResult;
  if (!result || !result.doc_no || !result.id) {
    return { ok: false, message: "ออกใบกำกับภาษีไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id: result.id, docNo: result.doc_no };
}

/** ยกเลิกใบกำกับภาษี (เฉพาะจาก status='issued') — ไม่มีทางย้อนกลับ เลขเดิมไม่ reuse ถ้าจะออกใหม่ */
export async function voidTaxInvoice(
  db: DB,
  tenantId: string,
  id: string,
  reason: unknown
): Promise<TaxInvoiceActionResult> {
  const voidReason = clampText(reason, VOID_REASON_MAX);
  const { data: updated, error } = await db
    .from("tax_invoices")
    .update({ status: "void", void_reason: voidReason, voided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "issued") // atomic guard — กัน void ซ้ำ/race
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  if (!updated) return { ok: false, message: "ยกเลิกได้เฉพาะใบกำกับภาษีที่ยังไม่ถูกยกเลิกเท่านั้น" };
  return { ok: true, id };
}
