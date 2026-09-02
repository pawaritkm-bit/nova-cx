/**
 * ใบลดหนี้/ใบเพิ่มหนี้ (Credit Note / Debit Note) — data layer (DB) + validate + pure mapper
 *
 * บริบท: เฟส 3 ส่วน J (docs/06-accounting-features-roadmap.md, หมวด 0.3-0.9) — จำกัดเฉพาะบิลเชื่อ
 *   (payment_method='credit') ที่ยืนยันแล้วเท่านั้น (0.3, reuse isCreditEligibleForPayment ตรง ๆ
 *   จาก bill-payments.ts — ไม่เขียน eligibility ใหม่คู่ขนาน) แยกตารางใหม่ทั้งหมด (0.4 — เหตุผลเดียวกับ
 *   bill_payments/manual_journal_entries: โครงสร้างข้อมูลคนละแบบกับหัวบิล + ต้องอ้างอิงใบกำกับภาษีต้นฉบับ)
 *
 * ★ eligibility/scope: reuse isCreditEligibleForPayment + getBillPaymentScope ตรง ๆ (0.3/0.9)
 * ★ double-entry (0.5): contra คงที่เสมอ = AR (1140) ฝั่งขาย / AP (2010) ฝั่งซื้อ — reuse
 *   contraAccountFor(chartByCode, 'credit', entryType) ตรง ๆ ไม่เขียน mapping ใหม่
 * ★ สถานะ: draft แก้ไข/ลบได้อิสระ · confirmed ล็อกแก้ไข ยกเลิกได้ด้วย soft-delete เท่านั้น (0.4)
 * ★ CN/DN ไม่กระทบยอดหัก ณ ที่จ่าย (WHT) เดิมของบิลต้นฉบับ (0.8) — ไม่มีคอลัมน์ wht เลย
 * ★ ทุก write ต้อง re-fetch scope ผ่าน getNoteEntryScope ก่อนเขียนเสมอ (ไม่เชื่อ client)
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { contraAccountFor } from "@/lib/accounting/payment";
import { chunkIds } from "@/lib/accounting/id-chunk";
import { deriveThbAmount } from "@/lib/accounting/currency";
import { round2, summarizeEntry, type EntryType } from "@/lib/accounting/queries";
import { INPUT_VAT, OUTPUT_VAT, EPSILON } from "@/lib/accounting/statement-config";
import type { JournalLine } from "@/lib/accounting/journal";
import type { JournalPosting, PostingLeg, BookKind } from "@/lib/accounting/journal-books";
import {
  isCreditEligibleForPayment,
  getBillPaymentScope,
  type BillPaymentScope,
  type PaymentEntryInfo,
} from "@/lib/accounting/bill-payments";

type DB = SupabaseClient;

export type NoteDocType = "credit_note" | "debit_note";
export type NoteStatus = "draft" | "confirmed";

/** ป้ายภาษาไทย */
export const NOTE_DOC_TYPE_LABELS: Record<NoteDocType, string> = {
  credit_note: "ใบลดหนี้",
  debit_note: "ใบเพิ่มหนี้",
};

/** เพดานความยาว/จำนวน (กัน payload ใหญ่ผิดปกติ) */
export const DOC_NO_MAX = 50;
export const REASON_MAX = 500;
export const DESCRIPTION_MAX = 200;
export const ACCOUNT_NAME_MAX = 200;
export const ACCOUNT_CODE_MAX = 20;
export const MIN_LINES = 1;
export const MAX_LINES = 50;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function asNoteDocType(v: unknown): NoteDocType | null {
  return v === "credit_note" || v === "debit_note" ? v : null;
}

/** ยอดเงิน → number (>=0 ปัด 2 ตำแหน่ง) — ค่าติดลบ/ไม่ใช่ตัวเลข = 0 (ห้ามยอดติดลบต่อบรรทัด) */
function asAmount(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

// ---------------------------------------------------------------------
// eligibility / scope — re-export ตรง ๆ (0.3/0.9, ไม่เขียนใหม่คู่ขนาน)
// ---------------------------------------------------------------------

/** บิลนี้ออก CN/DN ได้ไหม — เหมือน isCreditEligibleForPayment ทุกประการ (0.3) */
export const isEligibleForNote = isCreditEligibleForPayment;

/** สโคป + สิทธิ์ของบิลต้นทาง — เหมือน getBillPaymentScope ทุกประการ (0.9) */
export const getNoteEntryScope = getBillPaymentScope;
export type NoteEntryScope = BillPaymentScope;

// ---------------------------------------------------------------------
// 1 บรรทัด / 1 ใบ CN-DN (โหลดจาก DB แล้ว)
// ---------------------------------------------------------------------

/** 1 บรรทัดของ CN/DN (id มีเมื่อโหลดจาก DB แล้ว — ไม่มีตอนสร้างใหม่) */
export type CreditDebitNoteLine = {
  id?: string;
  lineNo: number;
  description: string | null;
  accountCode: string;
  accountName: string | null;
  /**
   * ยอดต้นฉบับสกุลต่างประเทศ (เฟส 10 ส่วน AA, migration 0087) — มีความหมายเฉพาะเมื่อบิลต้นทางเป็น FX
   *   (currency ไม่ null) เท่านั้น · เมื่อบิลต้นทาง currency=null (ปกติ) ไม่มีความหมาย (amount กรอกตรงเหมือนเดิม)
   */
  fxAmount?: number | null;
  amount: number;
  vatAmount: number;
};

/** หัว + บรรทัด CN/DN 1 ใบ */
export type CreditDebitNote = {
  id: string;
  tenantId: string;
  entryId: string;
  customerId: string | null;
  docType: NoteDocType;
  /** YYYY-MM-DD */
  docDate: string;
  docNo: string | null;
  reason: string;
  status: NoteStatus;
  createdAt: string;
  confirmedAt: string | null;
  lines: CreditDebitNoteLine[];
};

// ---------------------------------------------------------------------
// pure — ยอดรวม/ผลปรับปรุงสัญญาณ (0.4/0.5)
// ---------------------------------------------------------------------

/** ยอดรวม 1 บรรทัด = amount + vatAmount (reuse summarizeEntry — map whtAmount:0 เข้าไป ไม่มีสูตรคู่ขนาน) */
export function noteLineTotal(lines: Pick<CreditDebitNoteLine, "amount" | "vatAmount">[]): number {
  return summarizeEntry(lines.map((l) => ({ amount: l.amount, vatAmount: l.vatAmount, whtAmount: 0 }))).net;
}

/** ยอดรวมทั้งใบ CN/DN = Σ(line.amount + line.vatAmount) */
export function noteNetTotal(note: Pick<CreditDebitNote, "lines">): number {
  return noteLineTotal(note.lines);
}

/**
 * ผลปรับปรุงยอดค้างชำระแบบมีสัญญาณ (0.5/0.6) — ป้อนเข้า billOutstanding()/buildAgingReport()
 *   - credit_note (ลดยอด) → ลบ (ค่าติดลบ)
 *   - debit_note (เพิ่มยอด) → บวก (ค่าบวก)
 *   - draft (ยังไม่ยืนยัน) → 0 เสมอ (ไม่กระทบยอดจนกว่าจะ confirm)
 */
export function noteSignedAdjustment(note: Pick<CreditDebitNote, "docType" | "status" | "lines">): number {
  if (note.status !== "confirmed") return 0;
  const total = noteNetTotal(note);
  return note.docType === "credit_note" ? round2(-total) : round2(total);
}

// ---------------------------------------------------------------------
// validate (pure) — server ต้อง re-validate เสมอ ไม่เชื่อ client
// ---------------------------------------------------------------------

/** input ดิบ 1 บรรทัด จาก client */
export type NoteLineInput = {
  description?: unknown;
  accountCode: unknown;
  accountName?: unknown;
  amount: unknown;
  vatAmount?: unknown;
  /** เฟส 10 ส่วน AA (0.10) — ยอดต้นฉบับสกุลต่างประเทศ (มีความหมายเฉพาะบิลต้นทาง FX เท่านั้น) */
  fxAmount?: unknown;
};

/** input ดิบทั้งใบ จาก client */
export type NoteInput = {
  docType: unknown;
  docDate: unknown;
  docNo?: unknown;
  reason: unknown;
  lines: NoteLineInput[];
};

export type ValidatedNote = {
  docType: NoteDocType;
  docDate: string;
  docNo: string | null;
  reason: string;
  lines: CreditDebitNoteLine[];
};

export type NoteValidationResult = { ok: true; value: ValidatedNote } | { ok: false; message: string };

/**
 * validate + sanitize input CN/DN — ปฏิเสธเสมอถ้า:
 *   - บิลไม่ eligible (0.3 — ไม่ใช่บิลเชื่อ/ยังไม่ confirmed)
 *   - doc_type/doc_date ผิดรูป, reason ว่าง (บังคับกรอกเหตุผล — ฟอร์ม RD บังคับระบุ)
 *   - lines ว่าง / เกินจำนวน / บรรทัดใดไม่มี account_code หรือ amount ≤ 0
 */
export function validateNoteInput(input: NoteInput, entry: PaymentEntryInfo): NoteValidationResult {
  if (!isEligibleForNote(entry)) {
    return { ok: false, message: "ออกใบลดหนี้/เพิ่มหนี้ได้เฉพาะบิลเชื่อที่ยืนยันแล้วเท่านั้น" };
  }

  const docType = asNoteDocType(input.docType);
  if (!docType) return { ok: false, message: "ต้องระบุประเภทเอกสาร (ใบลดหนี้/ใบเพิ่มหนี้)" };

  const docDate = typeof input.docDate === "string" && DATE_RE.test(input.docDate) ? input.docDate : "";
  if (!docDate) return { ok: false, message: "ต้องระบุวันที่เอกสารให้ถูกรูปแบบ" };

  const docNo = clampText(input.docNo, DOC_NO_MAX);
  const reason = clampText(input.reason, REASON_MAX);
  if (!reason) return { ok: false, message: "ต้องระบุเหตุผลในการออกเอกสาร" };

  if (!Array.isArray(input.lines) || input.lines.length < MIN_LINES) {
    return { ok: false, message: "ต้องมีอย่างน้อย 1 บรรทัด" };
  }
  if (input.lines.length > MAX_LINES) {
    return { ok: false, message: `บรรทัดมากเกินไป (สูงสุด ${MAX_LINES} บรรทัด)` };
  }

  // ★ เฟส 10 ส่วน AA (0.10) — บิลต้นทาง FX (entry.currency ไม่ null): amount ต่อบรรทัด derive จาก
  //   fxAmount × entry.fxRate (fx_rate "ของบิลต้นฉบับ" เสมอ — ไม่ใช่อัตราวันออก CN/DN) — บิลต้นทาง THB ปกติ
  //   (currency=null): amount ยังกรอกตรงเหมือนเดิมทุกประการ (backward-compat)
  const isFx = !!entry.currency;

  const lines: CreditDebitNoteLine[] = [];
  for (let i = 0; i < input.lines.length; i++) {
    const raw = input.lines[i];
    const accountCode = clampText(raw.accountCode, ACCOUNT_CODE_MAX);
    if (!accountCode) return { ok: false, message: `บรรทัดที่ ${i + 1}: ต้องเลือกรหัสบัญชี` };

    let amount: number;
    let fxAmount: number | null = null;
    if (isFx) {
      fxAmount = asAmount(raw.fxAmount);
      if (!nonZero(fxAmount)) {
        return { ok: false, message: `บรรทัดที่ ${i + 1}: ต้องระบุจำนวนเงินตราต่างประเทศมากกว่า 0` };
      }
      amount = deriveThbAmount(fxAmount, entry.fxRate ?? 0);
      if (!nonZero(amount)) return { ok: false, message: `บรรทัดที่ ${i + 1}: ต้องระบุจำนวนเงินมากกว่า 0` };
    } else {
      amount = asAmount(raw.amount);
      if (!nonZero(amount)) return { ok: false, message: `บรรทัดที่ ${i + 1}: ต้องระบุจำนวนเงินมากกว่า 0` };
    }

    const vatAmount = asAmount(raw.vatAmount);
    const accountName = clampText(raw.accountName, ACCOUNT_NAME_MAX);
    const description = clampText(raw.description, DESCRIPTION_MAX);
    lines.push({ lineNo: i + 1, description, accountCode, accountName, fxAmount, amount, vatAmount });
  }

  return { ok: true, value: { docType, docDate, docNo, reason, lines } };
}

// ---------------------------------------------------------------------
// pure mapper — ต่อเข้า engine บัญชี (0.5/0.7, reuse contraAccountFor('credit', entryType) ตรง ๆ)
// ---------------------------------------------------------------------

/** ข้อมูลบิลต้นทางเท่าที่ mapper ต้องใช้ */
export type NoteJournalEntry = {
  entryType: Extract<EntryType, "sale" | "purchase">;
  docNo: string | null;
  customerId: string | null;
  counterpartyName: string | null;
  /** ★ 2026-09-02 optional — fallback คำอธิบายเมื่อบิลไม่มีชื่อคู่ค้า (caller ส่ง BillEntry เต็มอยู่แล้ว) */
  lines?: { description: string | null }[];
};

/**
 * แปลง CN/DN 1 ใบ → JournalLine[] (0.5) — ตามตาราง 0.5 ครบ 4 กรณี (sale×credit/debit, purchase×credit/debit):
 *   - credit_note (ลดยอด) กลับทิศทั้งหมดของบิลปกติ:
 *       sale:     Dr แต่ละบัญชี=amount · Dr OUTPUT_VAT=Σvat · Cr AR=Σ(amount+vat)
 *       purchase: Dr AP=Σ(amount+vat) · Cr แต่ละบัญชี=amount · Cr INPUT_VAT=Σvat
 *   - debit_note (เพิ่มยอด) ทิศทางเดียวกับบิลปกติชนิดเดียวกัน:
 *       sale:     Dr AR=Σ(amount+vat) · Cr แต่ละบัญชี=amount · Cr OUTPUT_VAT=Σvat
 *       purchase: Dr แต่ละบัญชี=amount · Dr INPUT_VAT=Σvat · Cr AP=Σ(amount+vat)
 *   ★ ไม่ import buildJournalEntries จาก journal.ts — เขียนบรรทัด Dr/Cr เองแบบเดียวกับ bill-payments.ts
 *     (pipeline นั้นออกแบบมาสำหรับบิลเต็มใบ ไม่ใช่รายการปรับปรุง 2-3 บรรทัด)
 *   ★ caller ควรกรอง eligible (isEligibleForNote) + confirmed ก่อนเรียกเสมอ
 */
export function toJournalLines(
  note: Pick<CreditDebitNote, "id" | "docType" | "docDate" | "docNo" | "lines">,
  entry: NoteJournalEntry,
  chartByCode: ChartByCode
): JournalLine[] {
  if (entry.entryType !== "sale" && entry.entryType !== "purchase") return [];

  let sumAmount = 0;
  let sumVat = 0;
  for (const l of note.lines) {
    sumAmount += numLocal(l.amount);
    sumVat += numLocal(l.vatAmount);
  }
  sumAmount = round2(sumAmount);
  sumVat = round2(sumVat);
  const total = round2(sumAmount + sumVat);
  if (!nonZero(total)) return [];

  const contra = contraAccountFor(chartByCode, "credit", entry.entryType);
  if (!contra || !contra.code.trim()) return []; // defensive — sale/purchase คำนวณได้เสมอ (contra คงที่ AR/AP)

  const base = {
    entryId: note.id,
    date: note.docDate,
    docNo: note.docNo,
    customerId: entry.customerId,
    // ★ 2026-09-02 — บิลไม่มีชื่อคู่ค้า → ใช้คำอธิบายบรรทัดแรกแทน (เหมือน journal.ts)
    counterparty:
      (entry.counterpartyName ?? "").trim() ||
      ((entry.lines ?? []).find((l) => (l.description ?? "").trim())?.description?.trim() ?? null),
  };

  const lines: JournalLine[] = [];
  const pushDebit = (code: string, name: string, amount: number) => {
    const v = round2(amount);
    if (!nonZero(v)) return;
    lines.push({ ...base, accountCode: code, accountName: name, debit: v, credit: 0, side: "debit" });
  };
  const pushCredit = (code: string, name: string, amount: number) => {
    const v = round2(amount);
    if (!nonZero(v)) return;
    lines.push({ ...base, accountCode: code, accountName: name, debit: 0, credit: v, side: "credit" });
  };
  const lineAccountName = (l: CreditDebitNoteLine) => l.accountName ?? chartByCode[l.accountCode]?.name ?? l.accountCode;

  const isCredit = note.docType === "credit_note";
  const isSale = entry.entryType === "sale";
  const vatCode = isSale ? OUTPUT_VAT : INPUT_VAT;
  const vatName = chartByCode[vatCode]?.name ?? (isSale ? "ภาษีขาย" : "ภาษีซื้อ");

  if (isSale) {
    if (isCredit) {
      // credit_note × sale: Dr แต่ละบัญชี + Dr VAT ขาย · Cr AR
      for (const l of note.lines) pushDebit(l.accountCode, lineAccountName(l), l.amount);
      pushDebit(vatCode, vatName, sumVat);
      pushCredit(contra.code, contra.name, total);
    } else {
      // debit_note × sale: Dr AR · Cr แต่ละบัญชี + Cr VAT ขาย
      pushDebit(contra.code, contra.name, total);
      for (const l of note.lines) pushCredit(l.accountCode, lineAccountName(l), l.amount);
      pushCredit(vatCode, vatName, sumVat);
    }
  } else {
    if (isCredit) {
      // credit_note × purchase: Dr AP · Cr แต่ละบัญชี + Cr VAT ซื้อ
      pushDebit(contra.code, contra.name, total);
      for (const l of note.lines) pushCredit(l.accountCode, lineAccountName(l), l.amount);
      pushCredit(vatCode, vatName, sumVat);
    } else {
      // debit_note × purchase: Dr แต่ละบัญชี + Dr VAT ซื้อ · Cr AP
      for (const l of note.lines) pushDebit(l.accountCode, lineAccountName(l), l.amount);
      pushDebit(vatCode, vatName, sumVat);
      pushCredit(contra.code, contra.name, total);
    }
  }

  return lines;
}

/**
 * แปลง CN/DN 1 ใบ → JournalPosting (0.7) — เข้าเล่มตามฝั่งบิลเดิม (sale/purchase) ไม่ใช่ receipt/payment
 *   (CN/DN เป็น "รายการปรับปรุงยอดขาย/ซื้อ" ไม่ใช่เงินเข้า-ออกจริง) ผสมเข้าพารามิเตอร์ manualPostings
 *   เดิมของ buildJournalBooks() — generic พออยู่แล้วตั้งแต่เฟส 1 ไม่ต้องแก้ signature
 */
export function toJournalPosting(
  note: Pick<CreditDebitNote, "id" | "docType" | "docDate" | "docNo" | "reason" | "lines">,
  entry: NoteJournalEntry,
  chartByCode: ChartByCode
): JournalPosting {
  const lines = toJournalLines(note, entry, chartByCode);
  const debits: PostingLeg[] = lines
    .filter((l) => l.side === "debit")
    .map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, amount: l.debit }));
  const credits: PostingLeg[] = lines
    .filter((l) => l.side === "credit")
    .map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, amount: l.credit }));
  const totalDebit = round2(debits.reduce((s, d) => s + d.amount, 0));
  const totalCredit = round2(credits.reduce((s, c) => s + c.amount, 0));

  const book: BookKind = entry.entryType === "sale" ? "sale" : "purchase";
  const label = `${NOTE_DOC_TYPE_LABELS[note.docType]}${note.reason ? " — " + note.reason : ""}`;

  return {
    entryId: note.id,
    date: note.docDate,
    docNo: note.docNo,
    description: label,
    debits,
    credits,
    totalDebit,
    totalCredit,
    book,
  };
}

// ---------------------------------------------------------------------
// data layer (DB) — ทุก query/write กรอง tenant_id เสมอ
// ---------------------------------------------------------------------

const LIST_LIMIT = 500;
const BULK_LIST_LIMIT = 5000;

type RawHead = {
  id: string;
  tenant_id: string;
  entry_id: string;
  customer_id: string | null;
  doc_type: string;
  doc_date: string;
  doc_no: string | null;
  reason: string | null;
  status: string;
  created_at: string;
  confirmed_at: string | null;
};

type RawLine = {
  id: string;
  note_id: string;
  line_no: number;
  description: string | null;
  account_code: string;
  account_name: string | null;
  fx_amount?: number | string | null;
  amount: number | string;
  vat_amount: number | string;
};

const NOTE_COLUMNS =
  "id, tenant_id, entry_id, customer_id, doc_type, doc_date, doc_no, reason, status, created_at, confirmed_at";
const LINE_COLUMNS =
  "id, note_id, line_no, description, account_code, account_name, fx_amount, amount, vat_amount";

function mapNote(r: RawHead, lines: CreditDebitNoteLine[]): CreditDebitNote {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    entryId: r.entry_id,
    customerId: r.customer_id,
    docType: asNoteDocType(r.doc_type) ?? "credit_note",
    docDate: r.doc_date,
    docNo: r.doc_no,
    reason: r.reason ?? "",
    status: r.status === "confirmed" ? "confirmed" : "draft",
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    lines,
  };
}

function mapLine(r: RawLine): CreditDebitNoteLine {
  return {
    id: r.id,
    lineNo: r.line_no,
    description: r.description,
    accountCode: r.account_code,
    accountName: r.account_name,
    fxAmount: r.fx_amount === null || r.fx_amount === undefined ? null : numLocal(r.fx_amount),
    amount: numLocal(r.amount),
    vatAmount: numLocal(r.vat_amount),
  };
}

/** ประวัติ CN/DN ของบิล 1 ใบ (ไม่รวมรายการที่ยกเลิกแล้ว) เรียงวันที่เก่า→ใหม่ */
export async function listNotes(db: DB, tenantId: string, entryId: string): Promise<CreditDebitNote[]> {
  const { data: heads } = await db
    .from("credit_debit_notes")
    .select(NOTE_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId)
    .is("deleted_at", null)
    .order("doc_date", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(LIST_LIMIT);
  const rows = (heads ?? []) as unknown as RawHead[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: lineData } = await db
    .from("credit_debit_note_lines")
    .select(LINE_COLUMNS)
    .eq("tenant_id", tenantId)
    .in("note_id", ids)
    .order("line_no", { ascending: true });
  const linesByNote = new Map<string, CreditDebitNoteLine[]>();
  for (const r of (lineData ?? []) as unknown as RawLine[]) {
    const arr = linesByNote.get(r.note_id) ?? [];
    arr.push(mapLine(r));
    linesByNote.set(r.note_id, arr);
  }

  return rows.map((r) => mapNote(r, linesByNote.get(r.id) ?? []));
}

/** CN/DN ของหลายบิลพร้อมกัน (ใช้กับหน้ารายการ/รายงาน) → Map<entryId, CreditDebitNote[]> */
export async function listNotesForEntries(
  db: DB,
  tenantId: string,
  entryIds: string[]
): Promise<Map<string, CreditDebitNote[]>> {
  const result = new Map<string, CreditDebitNote[]>();
  if (entryIds.length === 0) return result;
  // ★ ตัดก้อน (chunkIds) กัน .in() ยาวเกิน limit ของ PostgREST เมื่อ tenant มีบิล/ใบลดหนี้เพิ่มหนี้สะสม
  //   มาก (พบจริงใน listEntries() — ดู commit 7ab9f91 และ lib/accounting/id-chunk.ts) — ทั้ง entryIds
  //   (เข้า) และ ids (บรรทัดที่ 2 ต่อจากนี้ — มาจากผลลัพธ์ query แรก ซึ่งเพดาน BULK_LIST_LIMIT=5000
  //   สูงกว่าจุดที่ .in() พังพออยู่แล้ว)
  const headChunks = await Promise.all(
    chunkIds(entryIds).map((ids) =>
      db
        .from("credit_debit_notes")
        .select(NOTE_COLUMNS)
        .eq("tenant_id", tenantId)
        .in("entry_id", ids)
        .is("deleted_at", null)
        .order("doc_date", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(BULK_LIST_LIMIT)
    )
  );
  const rows = headChunks.flatMap(({ data }) => (data ?? []) as unknown as RawHead[]);
  if (rows.length === 0) return result;

  const ids = rows.map((r) => r.id);
  const lineChunks = await Promise.all(
    chunkIds(ids).map((noteIds) =>
      db
        .from("credit_debit_note_lines")
        .select(LINE_COLUMNS)
        .eq("tenant_id", tenantId)
        .in("note_id", noteIds)
        .order("line_no", { ascending: true })
    )
  );
  const lineData = lineChunks.flatMap(({ data }) => data ?? []);
  const linesByNote = new Map<string, CreditDebitNoteLine[]>();
  for (const r of (lineData ?? []) as unknown as RawLine[]) {
    const arr = linesByNote.get(r.note_id) ?? [];
    arr.push(mapLine(r));
    linesByNote.set(r.note_id, arr);
  }

  for (const r of rows) {
    const note = mapNote(r, linesByNote.get(r.id) ?? []);
    const arr = result.get(note.entryId) ?? [];
    arr.push(note);
    result.set(note.entryId, arr);
  }
  return result;
}

/**
 * ผลรวมสัญญาณของ CN/DN "confirmed" เท่านั้นต่อบิล (0.6) — ใช้ป้อน billOutstanding()/buildAgingReport()
 *   pure — รับ Map ที่โหลดมาแล้ว (จาก listNotesForEntries) กรอง confirmed ก่อนรวมเสมอ
 */
export function netAdjustmentByEntry(notesByEntry: Map<string, CreditDebitNote[]>): Map<string, number> {
  const result = new Map<string, number>();
  for (const [entryId, notes] of notesByEntry) {
    let sum = 0;
    for (const n of notes) sum += noteSignedAdjustment(n);
    result.set(entryId, round2(sum));
  }
  return result;
}

/**
 * ผลปรับปรุงยอดคงค้าง "สกุลต่างประเทศ" (ก่อน VAT) แบบมีสัญญาณ ของ CN/DN "confirmed" 1 ใบ (เฟส 10b, 0.3/0.10)
 *   — mirror noteSignedAdjustment เป๊ะ แต่สรุปจาก `line.fxAmount` แทน `line.amount + line.vatAmount`
 *   (0.3: ฐานคำนวณ revaluation ต้องไม่รวม VAT เสมอ — VAT เป็นตัวเงินบาทเสมอตามกฎหมายไทย ไม่ใช่ monetary item
 *   สกุลต่างประเทศ) — บิลต้นทาง THB ปกติ (ไม่มี fxAmount ต่อบรรทัดเลย) → คืน 0 เสมอ (ไม่ throw)
 *   - credit_note (ลดยอด) → ลบ (ค่าติดลบ) · debit_note (เพิ่มยอด) → บวก · draft (ยังไม่ยืนยัน) → 0 เสมอ
 */
export function noteFxSignedAdjustment(note: Pick<CreditDebitNote, "docType" | "status" | "lines">): number {
  if (note.status !== "confirmed") return 0;
  let total = 0;
  for (const l of note.lines) total += numLocal(l.fxAmount ?? 0);
  total = round2(total);
  return note.docType === "credit_note" ? round2(-total) : total;
}

/**
 * ผลรวมสัญญาณของ CN/DN "confirmed" ต่อบิล ฐานสกุลต่างประเทศ (ก่อน VAT) — ป้อนเข้า
 *   fx-revaluation.ts::outstandingFxForEntry (เฟส 10b, 0.4/0.10) — pure, รับ Map ที่โหลดมาแล้ว
 *   (จาก listNotesForEntries) กรอง confirmed ก่อนรวมเสมอ (ผ่าน noteFxSignedAdjustment)
 *   @param asOfDate เฟส 10b (0.5) — YYYY-MM-DD, optional · ไม่ส่ง = ไม่กรอง (นับ CN/DN confirmed ทุกใบ) ·
 *     ส่งมา = กรอง note.docDate ≤ asOfDate ก่อนรวม (กัน CN/DN วันที่ในอนาคตหลุดเข้ามาตอนตั้งรายงานย้อนหลัง)
 *   ★ ไม่แก้ noteSignedAdjustment/netAdjustmentByEntry เดิมเลย (ฟังก์ชันใหม่แยกต่างหากทั้งหมด)
 */
export function netFxAdjustmentByEntry(
  notesByEntry: Map<string, CreditDebitNote[]>,
  asOfDate?: string
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [entryId, notes] of notesByEntry) {
    let sum = 0;
    for (const n of notes) {
      if (asOfDate && n.docDate > asOfDate) continue;
      sum += noteFxSignedAdjustment(n);
    }
    result.set(entryId, round2(sum));
  }
  return result;
}

/** ผลลัพธ์ที่ server action ใช้แสดง toast/inline */
export type NoteActionResult = { ok: true; id: string } | { ok: false; message: string };

async function loadEntryLineAmountsForNote(
  db: DB,
  tenantId: string,
  entryId: string
): Promise<Pick<PaymentEntryInfo, "lines">["lines"]> {
  const { data } = await db
    .from("bill_entry_lines")
    .select("amount, vat_amount, wht_amount")
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId);
  return ((data ?? []) as { amount: number | string | null; vat_amount: number | string | null; wht_amount: number | string | null }[]).map(
    (r) => ({ amount: numLocal(r.amount), vatAmount: numLocal(r.vat_amount), whtAmount: numLocal(r.wht_amount) })
  );
}

/**
 * สร้าง/แก้ CN/DN ทั้งใบ (header + แทนที่ lines ทั้งหมด) — validate ซ้ำฝั่ง server เสมอ
 *   - id ระบุ = update (ต้องเป็น status='draft' เท่านั้น — confirmed แล้วแก้ไม่ได้ ต้อง softDelete แล้วสร้างใหม่)
 *   - id ไม่ระบุ = insert ใหม่ (status='draft' เสมอ)
 *   ★ re-fetch scope ผ่าน getNoteEntryScope ก่อนเขียนเสมอ (0.9)
 */
export async function createDraftNote(
  db: DB,
  tenantId: string,
  entryId: string,
  input: NoteInput
): Promise<NoteActionResult> {
  const scope = await getNoteEntryScope(db, tenantId, entryId);
  if (!scope) return { ok: false, message: "ไม่พบบิล (อาจถูกลบไปแล้ว)" };

  const lines = await loadEntryLineAmountsForNote(db, tenantId, entryId);
  const v = validateNoteInput(input, {
    entryType: scope.entryType,
    paymentMethod: scope.paymentMethod,
    status: scope.status,
    lines,
    currency: scope.currency,
    fxRate: scope.fxRate,
  });
  if (!v.ok) return { ok: false, message: v.message };

  const { data, error } = await db
    .from("credit_debit_notes")
    .insert({
      tenant_id: tenantId,
      entry_id: entryId,
      customer_id: scope.customerId,
      doc_type: v.value.docType,
      doc_date: v.value.docDate,
      doc_no: v.value.docNo,
      reason: v.value.reason,
      status: "draft",
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "เพิ่มรายการไม่สำเร็จ กรุณาลองใหม่" };
  const newId = (data as { id: string }).id;

  const { error: lineErr } = await db.from("credit_debit_note_lines").insert(
    v.value.lines.map((l) => ({
      note_id: newId,
      tenant_id: tenantId,
      line_no: l.lineNo,
      description: l.description,
      account_code: l.accountCode,
      account_name: l.accountName,
      fx_amount: l.fxAmount ?? null,
      amount: l.amount,
      vat_amount: l.vatAmount,
    }))
  );
  if (lineErr) {
    await db.from("credit_debit_notes").delete().eq("id", newId).eq("tenant_id", tenantId);
    return { ok: false, message: "เพิ่มบรรทัดไม่สำเร็จ กรุณาลองใหม่" };
  }
  return { ok: true, id: newId };
}

/** โหลด scope + สถานะของ CN/DN 1 ใบ (ผ่าน entry ต้นทาง) — คืน null ถ้าไม่พบ */
async function getNoteHead(
  db: DB,
  tenantId: string,
  id: string
): Promise<{ entryId: string; status: NoteStatus } | null> {
  const { data } = await db
    .from("credit_debit_notes")
    .select("entry_id, status")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as { entry_id: string; status: string };
  return { entryId: r.entry_id, status: r.status === "confirmed" ? "confirmed" : "draft" };
}

/** สโคปของ CN/DN 1 ใบ derive จาก id ของ note โดยตรง — customerId มาจากการอ่านสดผ่านบิลต้นทางเสมอ */
export type NoteScope = { customerId: string | null; entryId: string; status: NoteStatus };

/**
 * โหลดสโคป + สถานะของ CN/DN 1 ใบ จาก id ของ note นั้นเอง (ไม่รับ entryId คู่แยกจาก client) — คืน null
 * ถ้าไม่พบ/ถูกลบ/บิลต้นทางหาไม่เจอ
 *   ★ กัน IDOR: resource ที่กำลังจะเขียนจริงคือ `id` — สโคปต้อง derive จาก `id` นั้นตรง ๆ เท่านั้น
 *     ไม่ใช่จาก entryId ที่ client ส่งมาแยกต่างหาก (entryId นั้นอาจไม่ตรงกับ note ตัวจริงที่ id ระบุ)
 *   ★ ความจริงของสิทธิ์อ่านสดผ่าน getNoteEntryScope (bill_entries ต้นทาง) เสมอ — ไม่ใช้สำเนา
 *     credit_debit_notes.customer_id ตัดสิน (ตามที่ตั้งใจไว้ใน migration 0069)
 *   ★ ต้องเรียกฟังก์ชันนี้ก่อนเขียนทุกครั้งที่มี id ของ note อยู่แล้ว (confirm/void/แก้ไข draft เดิม)
 */
export async function getNoteScope(db: DB, tenantId: string, id: string): Promise<NoteScope | null> {
  const head = await getNoteHead(db, tenantId, id);
  if (!head) return null;
  const entryScope = await getNoteEntryScope(db, tenantId, head.entryId);
  if (!entryScope) return null;
  return { customerId: entryScope.customerId, entryId: head.entryId, status: head.status };
}

/** แก้ไข CN/DN (เฉพาะ status='draft' เท่านั้น) — confirmed แล้วแก้ไม่ได้ (0.4) */
export async function updateDraftNote(
  db: DB,
  tenantId: string,
  id: string,
  input: NoteInput
): Promise<NoteActionResult> {
  const head = await getNoteHead(db, tenantId, id);
  if (!head) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
  if (head.status !== "draft") {
    return { ok: false, message: "รายการนี้ยืนยันแล้ว — แก้ไขไม่ได้ (ยกเลิกแล้วสร้างใหม่)" };
  }

  const scope = await getNoteEntryScope(db, tenantId, head.entryId);
  if (!scope) return { ok: false, message: "ไม่พบบิลต้นทาง (อาจถูกลบไปแล้ว)" };

  const lines = await loadEntryLineAmountsForNote(db, tenantId, head.entryId);
  const v = validateNoteInput(input, {
    entryType: scope.entryType,
    paymentMethod: scope.paymentMethod,
    status: scope.status,
    lines,
    currency: scope.currency,
    fxRate: scope.fxRate,
  });
  if (!v.ok) return { ok: false, message: v.message };

  // กัน TOCTOU race กับ confirmNote(): เช็ค status='draft' ตอน getNoteHead() ข้างบนเป็นแค่ "เดาสถานะล่าสุด
  // ที่รู้" — คำสั่ง UPDATE จริงต้องกำกับ .eq("status","draft") เองด้วยเสมอ (atomic check-and-write) แล้ว
  // เช็คว่ามีแถวถูกอัปเดตจริงหรือไม่ ถ้า confirmNote() แทรกเข้ามาพอดีระหว่างนี้ ต้องคืน error ชัดเจน
  const { data: updated, error } = await db
    .from("credit_debit_notes")
    .update({
      doc_type: v.value.docType,
      doc_date: v.value.docDate,
      doc_no: v.value.docNo,
      reason: v.value.reason,
    })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" };
  if (!updated) {
    return { ok: false, message: "รายการนี้ยืนยันแล้ว — แก้ไขไม่ได้ (ยกเลิกแล้วสร้างใหม่)" };
  }

  await db.from("credit_debit_note_lines").delete().eq("note_id", id).eq("tenant_id", tenantId);
  const { error: lineErr } = await db.from("credit_debit_note_lines").insert(
    v.value.lines.map((l) => ({
      note_id: id,
      tenant_id: tenantId,
      line_no: l.lineNo,
      description: l.description,
      account_code: l.accountCode,
      account_name: l.accountName,
      fx_amount: l.fxAmount ?? null,
      amount: l.amount,
      vat_amount: l.vatAmount,
    }))
  );
  if (lineErr) return { ok: false, message: "บันทึกบรรทัดไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/** ยืนยัน CN/DN (draft → confirmed) — เข้ายอดค้างชำระ/รายงานทันทีหลังยืนยัน (0.4) */
export async function confirmNote(db: DB, tenantId: string, id: string): Promise<NoteActionResult> {
  const head = await getNoteHead(db, tenantId, id);
  if (!head) return { ok: false, message: "ไม่พบรายการ (อาจถูกลบไปแล้ว)" };
  if (head.status === "confirmed") return { ok: true, id };

  const { data: lineData } = await db
    .from("credit_debit_note_lines")
    .select("amount")
    .eq("note_id", id)
    .eq("tenant_id", tenantId);
  const lines = (lineData ?? []) as { amount: number | string }[];
  if (lines.length === 0) {
    return { ok: false, message: "รายการนี้ยังไม่มีบรรทัด — ยืนยันไม่ได้" };
  }

  const { error } = await db
    .from("credit_debit_notes")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ยืนยันไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}

/** ยกเลิก CN/DN (soft-delete) — ผิดพลาดต้องยกเลิกแล้วออกใบใหม่ที่ถูกต้อง (0.4) */
export async function softDeleteNote(db: DB, tenantId: string, id: string): Promise<NoteActionResult> {
  const head = await getNoteHead(db, tenantId, id);
  if (!head) return { ok: false, message: "ไม่พบรายการ (อาจถูกยกเลิกไปแล้ว)" };
  const { error } = await db
    .from("credit_debit_notes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ยกเลิกไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id };
}
