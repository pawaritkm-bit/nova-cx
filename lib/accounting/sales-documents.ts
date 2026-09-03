/**
 * ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล (Quotation/PO/Billing Note) — data layer (DB) + validate + pure
 *
 * บริบท: เฟส 3 ส่วน K (docs/06-accounting-features-roadmap.md, หมวด 0.10-0.16) — เอกสารช่วยขาย
 *   ก่อน/ระหว่างขาย-ซื้อ ใช้ตารางร่วม `sales_documents`+`sales_document_lines` เดียว (แยกด้วย
 *   `document_type`) ไม่กระทบ accounting engine เลย (0.11)
 *
 * ★★★ ห้าม import จาก journal.ts/ledger.ts/statements.ts/journal-books.ts/payment.ts เด็ดขาด (0.11) ★★★
 *   เอกสารกลุ่มนี้เป็นแค่ "งานเอกสาร" ไม่ใช่รายการทางบัญชี — ไม่มี toJournalLines/toJournalPosting
 *   ในไฟล์นี้ต่างจากส่วน J (credit-debit-notes.ts) โดยตั้งใจ
 * ★ เลขที่เอกสาร (doc_no) assign ตอน "ออกเอกสาร" (issue) เท่านั้น ผ่าน RPC `issue_sales_document`
 *   แบบ atomic (0.12) — ไม่ใช่ตอนสร้าง draft (กันเลขกระโดดจาก draft ที่ทิ้ง)
 * ★ สถานะ: draft แก้ไข/ลบได้อิสระ · issued ล็อกแก้ไข (แก้ผิดต้อง void แล้วสร้างใหม่) · void ยกเลิก
 *   จาก issued เท่านั้น ไม่มีทางย้อนกลับ (0.16)
 * ★ billing_note prefill จาก bill_entries เป็น "สำเนา ณ เวลาที่สร้าง" เท่านั้น (read-only reference,
 *   ไม่ sync ย้อนหลัง — 0.14) `source_bill_entry_id` ใช้ได้เฉพาะ document_type='billing_note'
 *   (บังคับที่ application layer นี้เท่านั้น ไม่มี DB constraint ข้าม document_type)
 * ★ ทุก query/write กรอง tenant_id เสมอ — assertCustomerInScope ทำที่ actions.ts ชั้นบน
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อลูกค้า/คู่ค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { round2, summarizeEntry, listEntries, type EntryType } from "@/lib/accounting/queries";
import {
  isCreditEligibleForPayment,
  billNetTotal,
  billOutstanding,
  listBillPaymentsForEntries,
} from "@/lib/accounting/bill-payments";
import { listNotesForEntries, netAdjustmentByEntry } from "@/lib/accounting/credit-debit-notes";
import { EPSILON } from "@/lib/accounting/statement-config";
import {
  asSalesDocType,
  beYearNowThai,
  formatSalesDocNo,
  DOC_TYPE_PREFIX,
  type SalesDocType,
} from "@/lib/accounting/doc-format";

type DB = SupabaseClient;

export type SalesDocStatus = "draft" | "issued" | "void";

/** เพดานความยาว/จำนวน (กัน payload ใหญ่ผิดปกติ) */
export const NOTES_MAX = 500;
export const DESCRIPTION_MAX = 200;
export const COUNTERPARTY_NAME_MAX = 200;
export const COUNTERPARTY_TAXID_MAX = 20;
export const COUNTERPARTY_ADDRESS_MAX = 300;
export const UNIT_MAX = 30;
export const MIN_LINES = 1;
export const MAX_LINES = 200;
export const QUANTITY_MAX = 1_000_000;
export const PRICE_MAX = 1_000_000_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonZero(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) >= EPSILON;
}

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

function asUuidOrNull(v: unknown): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}

/** ยอดเงิน → number (>=0 ปัด 2 ตำแหน่ง) — ค่าติดลบ/ไม่ใช่ตัวเลข = 0 (ห้ามยอดติดลบต่อบรรทัด) */
function asAmount(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

/** จำนวน — ไม่บังคับ (default 1) ค่าผิด/ติดลบ/ศูนย์ → กลับเป็น 1 (ใช้เพื่อแสดงผล ไม่ใช่แหล่งความจริงของยอด) */
function asQuantity(v: unknown): number {
  if (v === undefined || v === null || v === "") return 1;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(n, QUANTITY_MAX) * 1000) / 1000;
}

/** ราคาต่อหน่วย — ไม่บังคับ (default 0) ค่าผิด/ติดลบ → 0 */
function asUnitPrice(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return round2(Math.min(n, PRICE_MAX));
}

// ---------------------------------------------------------------------
// 1 บรรทัด / 1 เอกสาร (โหลดจาก DB แล้ว)
// ---------------------------------------------------------------------

/** 1 บรรทัดของเอกสาร (id/documentId มีเมื่อโหลดจาก DB แล้ว — ไม่มีตอนสร้างใหม่) */
export type SalesDocumentLine = {
  id?: string;
  lineNo: number;
  description: string | null;
  /** สินค้า/บริการที่ผูก (nullable — reuse products.ts เฟส 1 ส่วน B, ใช้ prefill เท่านั้น) */
  productId: string | null;
  /** บิลต้นทาง (เฉพาะ document_type='billing_note', 0.14) — read-only reference, snapshot ณ เวลาสร้าง */
  sourceBillEntryId: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  amount: number;
  vatAmount: number;
};

/** หัว + บรรทัดเอกสาร 1 ใบ */
export type SalesDocument = {
  id: string;
  tenantId: string;
  customerId: string;
  documentType: SalesDocType;
  /** null จนกว่าจะ "ออกเอกสาร" (issue) */
  docNo: string | null;
  /** YYYY-MM-DD */
  docDate: string;
  /** เฉพาะ quotation ใช้จริง (0.10) — ประเภทอื่น = null เสมอ */
  validUntil: string | null;
  counterpartyName: string | null;
  counterpartyTaxId: string | null;
  counterpartyAddress: string | null;
  notes: string | null;
  status: SalesDocStatus;
  createdAt: string;
  updatedAt: string;
  issuedAt: string | null;
  lines: SalesDocumentLine[];
};

// ---------------------------------------------------------------------
// pure — ยอดรวม (0.10, reuse summarizeEntry — ไม่มีสูตรคู่ขนาน)
// ---------------------------------------------------------------------

/** ยอดรวม = Σ(line.amount + line.vatAmount) — reuse summarizeEntry (map whtAmount:0 เข้าไป) */
export function lineTotal(lines: Pick<SalesDocumentLine, "amount" | "vatAmount">[]): number {
  return summarizeEntry(lines.map((l) => ({ amount: l.amount, vatAmount: l.vatAmount, whtAmount: 0 }))).net;
}

// ---------------------------------------------------------------------
// validate (pure) — server ต้อง re-validate เสมอ ไม่เชื่อ client
// ---------------------------------------------------------------------

/** input ดิบ 1 บรรทัด จาก client */
export type SalesDocLineInput = {
  description?: unknown;
  productId?: unknown;
  sourceBillEntryId?: unknown;
  quantity?: unknown;
  unit?: unknown;
  unitPrice?: unknown;
  amount: unknown;
  vatAmount?: unknown;
};

/** input ดิบทั้งใบ จาก client */
export type SalesDocumentInput = {
  documentType: unknown;
  docDate: unknown;
  validUntil?: unknown;
  counterpartyName?: unknown;
  counterpartyTaxId?: unknown;
  counterpartyAddress?: unknown;
  notes?: unknown;
  lines: SalesDocLineInput[];
};

export type ValidatedSalesDocLine = {
  description: string | null;
  productId: string | null;
  sourceBillEntryId: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  amount: number;
  vatAmount: number;
};

export type ValidatedSalesDocument = {
  documentType: SalesDocType;
  docDate: string;
  validUntil: string | null;
  counterpartyName: string | null;
  counterpartyTaxId: string | null;
  counterpartyAddress: string | null;
  notes: string | null;
  lines: SalesDocumentLine[];
};

export type SalesDocValidationResult =
  | { ok: true; value: ValidatedSalesDocument }
  | { ok: false; message: string };

/**
 * validate + sanitize input 1 บรรทัด — คืน null ถ้าไม่ผ่าน (amount ไม่มากกว่า 0)
 *   ★ quantity/unitPrice เป็นแค่ตัวช่วยแสดงผล (ไม่บังคับ ค่าผิด → default) — `amount` คือแหล่งความจริงของยอด
 */
export function validateLineInput(raw: SalesDocLineInput): ValidatedSalesDocLine | null {
  const amount = asAmount(raw.amount);
  if (!nonZero(amount)) return null;
  return {
    description: clampText(raw.description, DESCRIPTION_MAX),
    productId: asUuidOrNull(raw.productId),
    sourceBillEntryId: asUuidOrNull(raw.sourceBillEntryId),
    quantity: asQuantity(raw.quantity),
    unit: clampText(raw.unit, UNIT_MAX),
    unitPrice: asUnitPrice(raw.unitPrice),
    amount,
    vatAmount: asAmount(raw.vatAmount),
  };
}

/**
 * validate + sanitize input ทั้งใบ — ปฏิเสธเสมอถ้า:
 *   - document_type ไม่ถูกต้อง / doc_date ผิดรูป
 *   - lines ว่าง / เกินจำนวน / บรรทัดใด amount ไม่มากกว่า 0
 *   ★ valid_until บังคับ null เสมอถ้าไม่ใช่ quotation (0.10 — เพิกเฉยเงียบ ๆ ไม่ปฏิเสธทั้ง input)
 *   ★ source_bill_entry_id ต่อบรรทัด บังคับ null เสมอถ้าไม่ใช่ billing_note (0.10/0.14 — application layer)
 */
export function validateDocumentInput(input: SalesDocumentInput): SalesDocValidationResult {
  const documentType = asSalesDocType(input.documentType);
  if (!documentType) {
    return { ok: false, message: "ต้องระบุประเภทเอกสาร (ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล)" };
  }

  const docDate = typeof input.docDate === "string" && DATE_RE.test(input.docDate) ? input.docDate : "";
  if (!docDate) return { ok: false, message: "ต้องระบุวันที่เอกสารให้ถูกรูปแบบ" };

  const validUntil =
    documentType === "quotation" && typeof input.validUntil === "string" && DATE_RE.test(input.validUntil)
      ? input.validUntil
      : null;

  const counterpartyName = clampText(input.counterpartyName, COUNTERPARTY_NAME_MAX);
  const counterpartyTaxId = clampText(input.counterpartyTaxId, COUNTERPARTY_TAXID_MAX);
  const counterpartyAddress = clampText(input.counterpartyAddress, COUNTERPARTY_ADDRESS_MAX);
  const notes = clampText(input.notes, NOTES_MAX);

  if (!Array.isArray(input.lines) || input.lines.length < MIN_LINES) {
    return { ok: false, message: "ต้องมีอย่างน้อย 1 บรรทัด" };
  }
  if (input.lines.length > MAX_LINES) {
    return { ok: false, message: `บรรทัดมากเกินไป (สูงสุด ${MAX_LINES} บรรทัด)` };
  }

  const lines: SalesDocumentLine[] = [];
  for (let i = 0; i < input.lines.length; i++) {
    const v = validateLineInput(input.lines[i]);
    if (!v) return { ok: false, message: `บรรทัดที่ ${i + 1}: ต้องระบุจำนวนเงินมากกว่า 0` };
    lines.push({
      lineNo: i + 1,
      description: v.description,
      productId: v.productId,
      sourceBillEntryId: documentType === "billing_note" ? v.sourceBillEntryId : null,
      quantity: v.quantity,
      unit: v.unit,
      unitPrice: v.unitPrice,
      amount: v.amount,
      vatAmount: v.vatAmount,
    });
  }

  return {
    ok: true,
    value: { documentType, docDate, validUntil, counterpartyName, counterpartyTaxId, counterpartyAddress, notes, lines },
  };
}

// ---------------------------------------------------------------------
// data layer (DB) — ทุก query/write กรอง tenant_id เสมอ
// ---------------------------------------------------------------------

const LIST_LIMIT = 500;

type RawHead = {
  id: string;
  tenant_id: string;
  customer_id: string;
  document_type: string;
  doc_no: string | null;
  doc_date: string;
  valid_until: string | null;
  counterparty_name: string | null;
  counterparty_tax_id: string | null;
  counterparty_address: string | null;
  notes: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  issued_at: string | null;
};

type RawLine = {
  id: string;
  document_id: string;
  line_no: number;
  description: string | null;
  product_id: string | null;
  source_bill_entry_id: string | null;
  quantity: number | string;
  unit: string | null;
  unit_price: number | string;
  amount: number | string;
  vat_amount: number | string;
};

const DOC_COLUMNS =
  "id, tenant_id, customer_id, document_type, doc_no, doc_date, valid_until, counterparty_name, counterparty_tax_id, counterparty_address, notes, status, created_at, updated_at, issued_at";
const LINE_COLUMNS =
  "id, document_id, line_no, description, product_id, source_bill_entry_id, quantity, unit, unit_price, amount, vat_amount";

function asStatus(v: string): SalesDocStatus {
  return v === "issued" ? "issued" : v === "void" ? "void" : "draft";
}

function mapLine(r: RawLine): SalesDocumentLine {
  return {
    id: r.id,
    lineNo: r.line_no,
    description: r.description,
    productId: r.product_id,
    sourceBillEntryId: r.source_bill_entry_id,
    quantity: numLocal(r.quantity),
    unit: r.unit,
    unitPrice: numLocal(r.unit_price),
    amount: numLocal(r.amount),
    vatAmount: numLocal(r.vat_amount),
  };
}

function mapDocument(r: RawHead, lines: SalesDocumentLine[]): SalesDocument {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    customerId: r.customer_id,
    documentType: asSalesDocType(r.document_type) ?? "quotation",
    docNo: r.doc_no,
    docDate: r.doc_date,
    validUntil: r.valid_until,
    counterpartyName: r.counterparty_name,
    counterpartyTaxId: r.counterparty_tax_id,
    counterpartyAddress: r.counterparty_address,
    notes: r.notes,
    status: asStatus(r.status),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    issuedAt: r.issued_at,
    lines,
  };
}

/** สโคป + สถานะของเอกสาร (ใช้ตรวจสิทธิ์/ก่อนเขียนทุกครั้ง) */
export type SalesDocumentScope = { customerId: string; status: SalesDocStatus; documentType: SalesDocType };

/** โหลดสโคป + สถานะของเอกสาร 1 ใบ (scope tenant) — คืน null ถ้าไม่พบ/ถูกลบ */
export async function getDocumentScope(db: DB, tenantId: string, id: string): Promise<SalesDocumentScope | null> {
  const { data } = await db
    .from("sales_documents")
    .select("customer_id, status, document_type")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as { customer_id: string; status: string; document_type: string };
  return {
    customerId: r.customer_id,
    status: asStatus(r.status),
    documentType: asSalesDocType(r.document_type) ?? "quotation",
  };
}

/** เอกสาร 1 ใบ (header + lines) — ใช้หน้าฟอร์มแก้ไข/หน้าพิมพ์ */
export async function getSalesDocument(db: DB, tenantId: string, id: string): Promise<SalesDocument | null> {
  const { data } = await db
    .from("sales_documents")
    .select(DOC_COLUMNS)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const head = data as unknown as RawHead;

  const { data: lineData } = await db
    .from("sales_document_lines")
    .select(LINE_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("document_id", id)
    .order("line_no", { ascending: true });
  const lines = ((lineData ?? []) as unknown as RawLine[]).map(mapLine);
  return mapDocument(head, lines);
}

/** รายการเอกสารของลูกค้า 1 ราย (ไม่รวมที่ลบแล้ว) — กรองประเภทถ้าระบุ เรียงสร้างล่าสุดก่อน */
export async function listSalesDocuments(
  db: DB,
  tenantId: string,
  customerId: string,
  documentType?: SalesDocType
): Promise<SalesDocument[]> {
  let q = db
    .from("sales_documents")
    .select(DOC_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (documentType) q = q.eq("document_type", documentType);

  const { data: heads } = await q;
  const rows = (heads ?? []) as unknown as RawHead[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: lineData } = await db
    .from("sales_document_lines")
    .select(LINE_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("document_id", ids)
    .order("line_no", { ascending: true });
  const linesByDoc = new Map<string, SalesDocumentLine[]>();
  for (const r of (lineData ?? []) as unknown as RawLine[]) {
    const arr = linesByDoc.get(r.document_id) ?? [];
    arr.push(mapLine(r));
    linesByDoc.set(r.document_id, arr);
  }

  return rows.map((r) => mapDocument(r, linesByDoc.get(r.id) ?? []));
}

// ---------------------------------------------------------------------
// billing_note prefill — บิลเชื่อ confirmed ที่ยังค้างชำระของลูกค้ารายนั้น (0.14)
//   reuse isCreditEligibleForPayment + billOutstanding ตรง ๆ จาก bill-payments.ts (ไม่มีสูตรคู่ขนาน)
// ---------------------------------------------------------------------

/** บิลค้างชำระ 1 รายการ — ตัวเลือกให้เลือก prefill บรรทัดใบวางบิล */
export type BillingCandidate = {
  entryId: string;
  entryType: Extract<EntryType, "sale" | "purchase">;
  docNo: string | null;
  docDate: string | null;
  counterpartyName: string | null;
  netTotal: number;
  outstanding: number;
};

/**
 * บิลเชื่อ confirmed ที่ยังค้างชำระ (outstanding > 0) ของลูกค้ารายนั้น — สำหรับ prefill billing_note
 *   ★ เฟส 3 ส่วน J (0.6): ต้อง re-fetch CN/DN "confirmed" ของบิลที่กำลังพิจารณาก่อน แล้วส่ง netAdjustment
 *     เข้า billOutstanding() เสมอ (mirror pattern เดียวกับ payments/page.tsx + ar-ap-aging/page.tsx —
 *     ไม่งั้นบิลที่มี CN ยืนยันแล้วจะคำนวณยอดค้างชำระเกินจริง แล้วดึงเข้าใบวางบิลผิดยอด)
 */
export async function listBillingCandidates(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<BillingCandidate[]> {
  const { entries } = await listEntries(db, tenantId, { customerId });
  const eligible = entries.filter(isCreditEligibleForPayment);
  if (eligible.length === 0) return [];

  const paymentsByEntry = await listBillPaymentsForEntries(db, tenantId, eligible.map((e) => e.id));
  const notesByEntry = await listNotesForEntries(db, tenantId, eligible.map((e) => e.id));
  const netAdjByEntry = netAdjustmentByEntry(notesByEntry);

  const candidates: BillingCandidate[] = [];
  for (const e of eligible) {
    const payments = paymentsByEntry.get(e.id) ?? [];
    const outstanding = billOutstanding(e, payments, netAdjByEntry.get(e.id) ?? 0);
    if (outstanding <= EPSILON) continue; // เฉพาะที่ยังค้างชำระจริง
    candidates.push({
      entryId: e.id,
      entryType: e.entryType as Extract<EntryType, "sale" | "purchase">,
      docNo: e.docNo,
      docDate: e.docDate,
      counterpartyName: e.counterpartyName,
      netTotal: billNetTotal(e),
      outstanding,
    });
  }
  return candidates.sort((a, b) => (b.docDate ?? "").localeCompare(a.docDate ?? ""));
}

// ---------------------------------------------------------------------
// เขียน (draft only) — สร้าง/แก้/ลบ
// ---------------------------------------------------------------------

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline */
export type SalesDocActionResult = { ok: true; id: string } | { ok: false; message: string };

/** สร้างเอกสารร่างใหม่ (status='draft' เสมอ, doc_no=null จนกว่าจะออกเอกสาร) */
export async function createDraftDocument(
  db: DB,
  tenantId: string,
  customerId: string,
  input: SalesDocumentInput
): Promise<SalesDocActionResult> {
  const v = validateDocumentInput(input);
  if (!v.ok) return { ok: false, message: v.message };

  const { data, error } = await db
    .from("sales_documents")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      document_type: v.value.documentType,
      doc_date: v.value.docDate,
      valid_until: v.value.validUntil,
      counterparty_name: v.value.counterpartyName,
      counterparty_tax_id: v.value.counterpartyTaxId,
      counterparty_address: v.value.counterpartyAddress,
      notes: v.value.notes,
      status: "draft",
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "เพิ่มรายการไม่สำเร็จ กรุณาลองใหม่" };
  const newId = (data as { id: string }).id;

  const { error: lineErr } = await db.from("sales_document_lines").insert(
    v.value.lines.map((l) => ({
      document_id: newId,
      tenant_id: tenantId,
      line_no: l.lineNo,
      description: l.description,
      product_id: l.productId,
      source_bill_entry_id: l.sourceBillEntryId,
      quantity: l.quantity,
      unit: l.unit,
      unit_price: l.unitPrice,
      amount: l.amount,
      vat_amount: l.vatAmount,
    }))
  );
  if (lineErr) {
    await db.from("sales_documents").delete().eq("id", newId).eq("tenant_id", tenantId);
    return { ok: false, message: "เพิ่มบรรทัดไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id: newId };
}

/**
 * แก้ไขเอกสารร่าง (เฉพาะ status='draft' เท่านั้น — issued/void แก้ไม่ได้ 0.16)
 *   ★ บังคับ document_type ตามที่มีอยู่แล้วเสมอ (ไม่เชื่อ input — กันสลับประเภทเอกสารทีหลัง)
 *   ★ กัน TOCTOU race กับ issueDocument(): เช็ค status='draft' ตอน getDocumentScope() ข้างบน
 *     เป็นแค่ "เดาสถานะล่าสุดที่รู้" — คำสั่ง UPDATE จริงด้านล่างต้องกำกับ .eq("status","draft") เอง
 *     ด้วยเสมอ (atomic check-and-write) แล้วเช็คว่ามีแถวถูกอัปเดตจริงหรือไม่ (.select+.maybeSingle) —
 *     ถ้า issueDocument() แทรกเข้ามาพอดีระหว่างนี้ แถวจะไม่ match แล้วต้องคืน error ชัดเจน ไม่ใช่เขียนทับเงียบ ๆ
 */
export async function updateDraftDocument(
  db: DB,
  tenantId: string,
  id: string,
  input: SalesDocumentInput
): Promise<SalesDocActionResult> {
  const head = await getDocumentScope(db, tenantId, id);
  if (!head) return { ok: false, message: "ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" };
  if (head.status !== "draft") {
    return { ok: false, message: "เอกสารนี้ออกเลขที่แล้ว — แก้ไขไม่ได้ (ยกเลิกแล้วสร้างใหม่)" };
  }

  const v = validateDocumentInput({ ...input, documentType: head.documentType });
  if (!v.ok) return { ok: false, message: v.message };

  const { data: updated, error } = await db
    .from("sales_documents")
    .update({
      doc_date: v.value.docDate,
      valid_until: v.value.validUntil,
      counterparty_name: v.value.counterpartyName,
      counterparty_tax_id: v.value.counterpartyTaxId,
      counterparty_address: v.value.counterpartyAddress,
      notes: v.value.notes,
    })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "draft") // atomic guard — กัน race กับ issue_sales_document ที่แทรกเข้ามาพอดี
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  if (!updated) {
    return { ok: false, message: "เอกสารนี้ออกเลขที่แล้ว — แก้ไขไม่ได้ (ยกเลิกแล้วสร้างใหม่)" };
  }

  await db.from("sales_document_lines").delete().eq("document_id", id).eq("tenant_id", tenantId);
  const { error: lineErr } = await db.from("sales_document_lines").insert(
    v.value.lines.map((l) => ({
      document_id: id,
      tenant_id: tenantId,
      line_no: l.lineNo,
      description: l.description,
      product_id: l.productId,
      source_bill_entry_id: l.sourceBillEntryId,
      quantity: l.quantity,
      unit: l.unit,
      unit_price: l.unitPrice,
      amount: l.amount,
      vat_amount: l.vatAmount,
    }))
  );
  if (lineErr) return { ok: false, message: "บันทึกบรรทัดไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/**
 * ลบเอกสารร่าง (soft-delete) — เฉพาะ status='draft' เท่านั้น (ไม่เสียเลขเพราะยังไม่มีเลข 0.16)
 *   ★ กัน TOCTOU race กับ issueDocument() แบบเดียวกับ updateDraftDocument — .eq("status","draft")
 *     ต้องกำกับคำสั่งเขียนจริงเอง แล้วเช็คว่ามีแถวถูกลบจริงหรือไม่ (ไม่ใช่แค่เช็คตอน getDocumentScope() ก่อนหน้า)
 */
export async function softDeleteDraft(db: DB, tenantId: string, id: string): Promise<SalesDocActionResult> {
  const head = await getDocumentScope(db, tenantId, id);
  if (!head) return { ok: false, message: "ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" };
  if (head.status !== "draft") {
    return { ok: false, message: "ลบได้เฉพาะเอกสารร่างเท่านั้น — เอกสารที่ออกเลขแล้วให้ใช้ปุ่มยกเลิกแทน" };
  }
  const { data: deleted, error } = await db
    .from("sales_documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "draft") // atomic guard — กัน race กับ issue_sales_document ที่แทรกเข้ามาพอดี
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  if (!deleted) {
    return { ok: false, message: "ลบได้เฉพาะเอกสารร่างเท่านั้น — เอกสารที่ออกเลขแล้วให้ใช้ปุ่มยกเลิกแทน" };
  }
  return { ok: true, id };
}

/**
 * ลบเอกสาร "ทุกสถานะ" (soft delete) — ★ 2026-09-03 ผู้ใช้: "ตั้งให้ใบวางบิลที่ออกแล้วสามารถกดลบได้"
 *   ต่างจาก softDeleteDraft ตรงไม่จำกัด status: ร่าง/ออกเลขแล้ว/ยกเลิกแล้ว ลบได้หมด
 *   ★ เลขที่เอกสารที่ออกไปแล้วจะ "ไม่ถูกนำกลับมาใช้ซ้ำ" (ลำดับเลขเดินหน้าอย่างเดียว — เลขนั้นหายเป็นช่องว่าง)
 *   ★ soft delete (deleted_at) — ข้อมูลยังอยู่ใน DB กู้คืนได้โดยผู้ดูแลระบบ
 */
export async function softDeleteDocument(db: DB, tenantId: string, id: string): Promise<SalesDocActionResult> {
  const head = await getDocumentScope(db, tenantId, id);
  if (!head) return { ok: false, message: "ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" };
  const { data: deleted, error } = await db
    .from("sales_documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null) // atomic guard — กันลบซ้ำซ้อนพร้อมกัน
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, message: "ลบไม่สำเร็จ กรุณาลองใหม่" };
  if (!deleted) return { ok: false, message: "ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" };
  return { ok: true, id };
}

// ---------------------------------------------------------------------
// ออกเอกสาร / ยกเลิก — 0.12/0.16
// ---------------------------------------------------------------------

export type IssueDocumentResult = { ok: true; id: string; docNo: string } | { ok: false; message: string };

type RpcResult = { id?: string; doc_no?: string } | null;

/**
 * ออกเอกสาร (draft → issued) — assign doc_no แบบ atomic ผ่าน RPC `issue_sales_document` (0.12)
 *   ★ คำนวณ prefix + ปี พ.ศ. ปัจจุบัน (ตอนกดออกเอกสารจริง) จาก doc-format.ts ก่อนส่งเข้า RPC
 *   ★ RPC เองตรวจซ้ำว่าแถวยังเป็น draft อยู่ก่อนอัปเดต — ถ้าไม่ใช่ (ถูกออก/ยกเลิกไปแล้ว) จะ error กลับมา
 *     ทั้งฟังก์ชัน rollback (counter ไม่ถูกเผาทิ้ง) — ผู้เรียกที่มาช้ากว่าเห็น error ให้กดใหม่
 */
export async function issueDocument(
  db: DB,
  tenantId: string,
  id: string,
  documentType: SalesDocType
): Promise<IssueDocumentResult> {
  const beYear = beYearNowThai();
  const prefix = DOC_TYPE_PREFIX[documentType];

  const { data, error } = await db.rpc("issue_sales_document", {
    p_tenant_id: tenantId,
    p_document_id: id,
    p_document_type: documentType,
    p_be_year: beYear,
    p_prefix: prefix,
  });
  if (error) {
    return { ok: false, message: "ออกเอกสารไม่สำเร็จ (อาจถูกออกเลข/ยกเลิกไปแล้ว) กรุณาลองใหม่" };
  }
  const result = data as RpcResult;
  if (!result || !result.doc_no) {
    return { ok: false, message: "ออกเอกสารไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id, docNo: result.doc_no };
}

/** ยกเลิกเอกสาร (0.16) — เฉพาะจาก status='issued' เท่านั้น ไม่มีทางย้อนกลับเป็น draft/issued */
export async function voidDocument(db: DB, tenantId: string, id: string): Promise<SalesDocActionResult> {
  const head = await getDocumentScope(db, tenantId, id);
  if (!head) return { ok: false, message: "ไม่พบเอกสาร (อาจถูกลบไปแล้ว)" };
  if (head.status !== "issued") {
    return { ok: false, message: "ยกเลิกได้เฉพาะเอกสารที่ออกเลขที่แล้วเท่านั้น" };
  }
  const { error } = await db
    .from("sales_documents")
    .update({ status: "void" })
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}
