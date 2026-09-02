/**
 * กระทบยอดธนาคาร (Bank Reconciliation) — parser CSV + จับคู่ book/statement + data layer (DB)
 *
 * บริบท: เฟส 6 ส่วน T (docs/06-accounting-features-roadmap.md, หมวด 0.13–0.19) — เทียบยอดบัญชีธนาคาร
 *   ใน nova-cx (ฝั่ง "book" จาก JournalLine[] เดิม) กับ statement ธนาคารจริง (นำเข้า CSV template ตายตัว
 *   หรือกรอกมือ) — ทำทีละ 1 บัญชีเงินฝากของลูกค้า 1 ราย ต่อ 1 งวด (0.19)
 *
 * ★ 0.13 parser CSV เขียนเอง (pure) — ไม่เพิ่ม npm dependency ใหม่ — รองรับ BOM UTF-8/CRLF/quoted field
 *   ที่มี comma ในคำอธิบาย · ปฏิเสธแถวผิดรูปแบบพร้อมเลขบรรทัด (all-or-nothing ต่อไฟล์ — ไม่ import ครึ่ง ๆ
 *   กลาง ๆ ถ้ามีแถวผิดพลาดแม้แถวเดียว ให้ผู้ใช้แก้ไฟล์แล้วอัปใหม่)
 *   convention amount: + = เงินเข้าบัญชี (debit ของบัญชีสินทรัพย์) · − = เงินออกจากบัญชี (credit)
 * ★ 0.14 ฝั่ง book ดึงจาก buildJournalEntries(บิล) + flattenCombinedJournalLines(loadCombinedJournalLines(
 *   manual JE/bill_payments/CN-DN)) ของลูกค้า+งวดที่เลือก กรองเฉพาะ accountCode ของบัญชีเงินฝากที่เลือก
 *   — ไม่สร้างแหล่งข้อมูลคู่ขนานใหม่ (listBookLines wrap ให้ครบ)
 * ★ 0.15 bookLineKey = คีย์ผสม `${entryId}:${accountCode}:${side}:${amount}:${ลำดับที่เจอซ้ำ}`
 *   (buildBookLines คำนวณลำดับกันชนเอง) — เก็บ snapshot (entryId/date/amount) ไว้ในแถว
 *   bank_statement_lines ตอนยืนยันจับคู่ (confirmMatch) ไม่ใช่แค่คีย์เฉย ๆ
 * ★ 0.16 รายการต้นทางถูกแก้/ลบหลังจับคู่แล้ว — ไม่ auto-repair แต่เตือนผ่านเทียบ snapshot (isMatchStale)
 * ★ 0.17/0.18 auto-suggest (suggestMatches) + manual-confirm เสมอ — ไม่ auto-confirm/auto-post เด็ดขาด
 * ★ ทุก query/write กรอง tenant_id (จาก session) + customer_id/bank_account_id
 *   (assertCustomerInScope ที่ actions.ts ชั้นบน)
 * ★ PDPA: ไม่ log ตัวเลข/ชื่อบัญชี/ชื่อลูกค้า/รายละเอียด statement
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import { listEntries, round2 } from "@/lib/accounting/queries";
import { buildJournalEntries, type JournalLine, type JournalSide } from "@/lib/accounting/journal";
import { type ReportPeriod, filterEntriesForReport, validMonth } from "@/lib/accounting/report-filter";
import { loadCombinedJournalLines, flattenCombinedJournalLines } from "@/lib/accounting/statement-inputs";
import { EPSILON } from "@/lib/accounting/statement-config";
import { listCustomerBankAccounts, type CustomerBankAccount } from "@/lib/accounting/bank-accounts";
import { bankAccountCodesOf } from "@/lib/accounting/chart-of-accounts";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";

type DB = SupabaseClient;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DESCRIPTION_MAX = 200;
/** ห่างกันไม่เกินกี่วันถึงจะแนะนำจับคู่ (0.17 — เผื่อเช็ค/โอนขึ้นบัญชีธนาคารช้ากว่าวันที่บันทึกบัญชี) */
const MATCH_MAX_DAYS_APART = 7;

// ---------------------------------------------------------------------
// helper เล็ก ๆ (private)
// ---------------------------------------------------------------------

function clampText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * ตรวจว่าเป็นวันที่ปฏิทินจริง (กันเช่น 2026-02-30 ที่ผ่าน regex แต่ไม่มีจริง)
 * ★ export ไว้ให้ recurring-journal.ts (เฟส 6 ส่วน R) reuse ตรง ๆ — ไม่ duplicate โค้ดเดิม
 *   (ตรวจแล้วไม่มี circular dependency: ไฟล์นี้/dependency ของไฟล์นี้ ไม่มีที่ไหน import recurring-journal.ts)
 */
export function isValidCalendarDate(iso: string): boolean {
  if (!DATE_RE.test(iso)) return false;
  const y = Number(iso.slice(0, 4));
  const mo = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (mo < 1 || mo > 12) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** จำนวนวันห่างกัน (เต็มวัน, ค่าสัมบูรณ์) ระหว่าง 2 วันที่ YYYY-MM-DD — null ถ้าวันที่ผิดรูปแบบ */
function daysBetween(a: string, b: string): number | null {
  if (!DATE_RE.test(a) || !DATE_RE.test(b)) return null;
  const ta = Date.parse(`${a}T00:00:00.000Z`);
  const tb = Date.parse(`${b}T00:00:00.000Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round(Math.abs(ta - tb) / 86_400_000);
}

// =======================================================================
// A) parseBankStatementCsv — pure (T50, 0.13)
// =======================================================================

export type ParsedStatementRow = { date: string; description: string | null; amount: number };
export type CsvParseError = { line: number; message: string };
export type CsvParseResult =
  | { ok: true; rows: ParsedStatementRow[] }
  | { ok: false; errors: CsvParseError[] };

/** แยก 1 บรรทัดดิบเป็น field (คำนึงถึง quote — comma ในเครื่องหมายคำพูดไม่ถูกตัด, "" ใน quote = " ตัวจริง) */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * parse ไฟล์ CSV statement ธนาคาร (template ตายตัว 3 คอลัมน์: date,description,amount — 0.13)
 *   - ลอก BOM UTF-8 นำหน้าไฟล์ (ถ้ามี) + รองรับ CRLF/LF/CR ผสมกัน
 *   - แถวว่างข้าม (ไม่ใช่ error) · แถวหัวตาราง (date,description,amount — case-insensitive) ข้ามถ้าอยู่บรรทัด 1
 *   - แถวผิดรูปแบบ (จำนวนคอลัมน์ไม่ครบ 3 / วันที่ไม่ใช่ YYYY-MM-DD ที่มีจริง / amount ไม่ใช่ตัวเลข) →
 *     เก็บ error พร้อมเลขบรรทัดจริงของไฟล์ (นับ header/แถวว่างด้วย — ตรงกับที่นักบัญชีเห็นตอนเปิดไฟล์)
 *   - ★ all-or-nothing: มี error แม้แถวเดียว → ok:false (ไม่ import ครึ่ง ๆ กลาง ๆ ให้แก้ไฟล์แล้วอัปใหม่)
 */
export function parseBankStatementCsv(csvText: string): CsvParseResult {
  const text = csvText.replace(/^﻿/, ""); // ★ ลอก BOM UTF-8 นำหน้าไฟล์ (ถ้ามี)
  const lines = text.split(/\r\n|\r|\n/);

  const rows: ParsedStatementRow[] = [];
  const errors: CsvParseError[] = [];

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (raw.trim() === "") return; // แถวว่าง — ข้าม (ไม่ใช่ error)

    const fields = splitCsvLine(raw);

    // แถวหัวตาราง (เฉพาะบรรทัดแรกของไฟล์) — ข้าม ไม่นับเป็น error/ข้อมูล
    if (
      lineNo === 1 &&
      fields.length >= 3 &&
      fields[0].trim().toLowerCase() === "date" &&
      fields[1].trim().toLowerCase() === "description" &&
      fields[2].trim().toLowerCase() === "amount"
    ) {
      return;
    }

    if (fields.length !== 3) {
      errors.push({ line: lineNo, message: `บรรทัดที่ ${lineNo}: ต้องมี 3 คอลัมน์ (date,description,amount)` });
      return;
    }

    const date = fields[0].trim();
    const description = fields[1].trim();
    const amountRaw = fields[2].trim();

    if (!isValidCalendarDate(date)) {
      errors.push({ line: lineNo, message: `บรรทัดที่ ${lineNo}: วันที่ไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD)` });
      return;
    }

    if (amountRaw === "") {
      errors.push({ line: lineNo, message: `บรรทัดที่ ${lineNo}: ไม่ได้ระบุจำนวนเงิน` });
      return;
    }
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount)) {
      errors.push({ line: lineNo, message: `บรรทัดที่ ${lineNo}: จำนวนเงินไม่ใช่ตัวเลข ("${amountRaw}")` });
      return;
    }

    rows.push({ date, description: description || null, amount: round2(amount) });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rows };
}

/** เนื้อไฟล์ template ตัวอย่าง (ปุ่ม "ดาวน์โหลด template ตัวอย่าง" — 0.13) */
export const STATEMENT_CSV_TEMPLATE = [
  "date,description,amount",
  "2026-01-05,รับโอนจากลูกค้า,15000.00",
  "2026-01-07,ค่าธรรมเนียมธนาคาร,-50.00",
].join("\r\n");

// ---------------------------------------------------------------------
// validate 1 แถว (กรอกมือ — ใช้ input เดี่ยวจาก client)
// ---------------------------------------------------------------------

export type ValidatedStatementLine = { date: string; description: string | null; amount: number };
export type StatementLineValidationResult =
  | { ok: true; value: ValidatedStatementLine }
  | { ok: false; message: string };

/** validate input 1 บรรทัด statement ที่กรอกมือ (T51) */
export function validateStatementLineInput(input: {
  date: unknown;
  description?: unknown;
  amount: unknown;
}): StatementLineValidationResult {
  const date = typeof input.date === "string" ? input.date.trim() : "";
  if (!isValidCalendarDate(date)) {
    return { ok: false, message: "วันที่ไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD)" };
  }
  const description = clampText(input.description, DESCRIPTION_MAX);
  const amount = typeof input.amount === "number" ? input.amount : Number(input.amount);
  if (!Number.isFinite(amount)) return { ok: false, message: "จำนวนเงินไม่ถูกต้อง" };
  if (Math.abs(amount) < EPSILON) return { ok: false, message: "จำนวนเงินต้องไม่เป็นศูนย์" };
  return { ok: true, value: { date, description, amount: round2(amount) } };
}

// =======================================================================
// B) buildBookLines + bookLineKeyOf — pure (T50, 0.14/0.15)
// =======================================================================

/** 1 บรรทัด "ฝั่งบัญชี (book)" ที่กระทบบัญชีเงินฝากที่เลือก — คำนวณสดจาก JournalLine[] เสมอ (ไม่มี id ถาวร) */
export type BookLine = {
  /** composite key (0.15) — ใช้จับคู่/เขียน snapshot */
  key: string;
  entryId: string;
  accountCode: string;
  date: string | null;
  docNo: string | null;
  counterparty: string | null;
  /** signed แบบเดียวกับ statement: + = เงินเข้า (debit ของบัญชีสินทรัพย์) · − = เงินออก (credit) */
  amount: number;
};

/** สร้าง bookLineKey ผสม (0.15) — ลำดับที่เจอซ้ำ (occurrence) กันชนกรณี 2 บรรทัดยอดเท่ากันเป๊ะใน entry เดียวกัน */
export function bookLineKeyOf(
  entryId: string,
  accountCode: string,
  side: JournalSide,
  amount: number,
  occurrence: number
): string {
  return `${entryId}:${accountCode}:${side}:${amount}:${occurrence}`;
}

/**
 * กรอง JournalLine[] เฉพาะ accountCode ที่เลือก (บัญชีเงินฝากธนาคาร) แล้วแปลงเป็น BookLine[] พร้อม
 *   bookLineKey ผสม (0.15 — คำนวณลำดับที่เจอซ้ำเองในนี้ ไม่ต้อง caller ทำ)
 */
export function buildBookLines(journalLines: JournalLine[], accountCode: string): BookLine[] {
  const filtered = journalLines.filter((l) => l.accountCode === accountCode);
  const occurrenceByBaseKey = new Map<string, number>();
  const result: BookLine[] = [];

  for (const l of filtered) {
    const rawAmount = l.side === "debit" ? l.debit : l.credit;
    const baseKey = `${l.entryId}:${l.accountCode}:${l.side}:${rawAmount}`;
    const occurrence = occurrenceByBaseKey.get(baseKey) ?? 0;
    occurrenceByBaseKey.set(baseKey, occurrence + 1);

    const key = bookLineKeyOf(l.entryId, l.accountCode, l.side, rawAmount, occurrence);
    const signedAmount = round2(l.side === "debit" ? rawAmount : -rawAmount);

    result.push({
      key,
      entryId: l.entryId,
      accountCode: l.accountCode,
      date: l.date,
      docNo: l.docNo,
      counterparty: l.counterparty,
      amount: signedAmount,
    });
  }
  return result;
}

// =======================================================================
// C) statement line (แถว statement — จาก DB, มี id เสมอ) + snapshot จับคู่ (0.15/0.16)
// =======================================================================

export type BankStatementLine = {
  id: string;
  batchId: string | null;
  date: string;
  description: string | null;
  /** signed: + = เงินเข้า · − = เงินออก (0.13) */
  amount: number;
  matchedBookLineKey: string | null;
  matchedEntryId: string | null;
  matchedDate: string | null;
  matchedAmount: number | null;
  matchedAt: string | null;
};

/** statement line นี้จับคู่แล้วหรือยัง */
export function isStatementLineMatched(line: BankStatementLine): boolean {
  return !!line.matchedBookLineKey;
}

/**
 * รายการต้นทาง (book) ที่เคยจับคู่ไว้ "เปลี่ยนไปแล้ว" หรือไม่ (0.16) — เทียบ snapshot ที่เก็บไว้ตอนยืนยัน
 *   จับคู่ กับ BookLine ที่ re-compute สดล่าสุด (ไม่พบ bookLineKey เดิม = ถูกลบ/แก้จนคีย์เปลี่ยน,
 *   พบแต่ยอด/วันที่ไม่ตรง snapshot = ถูกแก้)
 *   ★ ไม่ auto-repair — แค่บอกให้นักบัญชีไปตรวจสอบ/ยกเลิกจับคู่แล้วจับคู่ใหม่เอง
 */
export function isMatchStale(
  line: BankStatementLine,
  currentBookLinesByKey: ReadonlyMap<string, BookLine>
): boolean {
  if (!line.matchedBookLineKey) return false;
  const current = currentBookLinesByKey.get(line.matchedBookLineKey);
  if (!current) return true;
  if (line.matchedAmount != null && Math.abs(current.amount - line.matchedAmount) >= EPSILON) return true;
  if (line.matchedDate && current.date !== line.matchedDate) return true;
  return false;
}

// =======================================================================
// D) suggestMatches — pure (T50, 0.17)
// =======================================================================

export type SuggestedMatch = {
  bookLine: BookLine;
  statementLine: BankStatementLine;
  /** จำนวนวันห่างกัน (0-7) */
  daysApart: number;
};

/**
 * แนะนำคู่จับคู่ (0.17) — เฉพาะคู่ที่ยอดตรงกัน (|bookAmount-stmtAmount| < EPSILON) และวันที่ห่างกันไม่เกิน
 *   7 วัน เรียงจากวันที่ใกล้กันที่สุดก่อน · ไม่แนะนำคู่ที่ฝั่งใดฝั่งหนึ่งจับคู่ไปแล้ว · แต่ละ book/statement
 *   line ปรากฏได้แค่ 1 คู่แนะนำในผลลัพธ์เดียวกัน (greedy — เลือกคู่ที่ใกล้วันที่สุดก่อนเสมอ กันแนะนำซ้ำ
 *   หลายคู่ที่แย่งกันจับกับ book/statement line เดียวกัน)
 *   ★ ไม่ auto-confirm — คืนแค่ "รายการแนะนำ" ผู้ใช้ต้องกดยืนยันเองทีละคู่ (confirmMatch)
 */
export function suggestMatches(bookLines: BookLine[], statementLines: BankStatementLine[]): SuggestedMatch[] {
  const availableBookLines = bookLines; // (bookLine ที่ "จับคู่แล้ว" คือ key ที่มีอยู่ใน matchedBookLineKey ของ statement)
  const matchedBookKeys = new Set(
    statementLines.filter((s) => s.matchedBookLineKey).map((s) => s.matchedBookLineKey as string)
  );
  const candidateBookLines = availableBookLines.filter((b) => !matchedBookKeys.has(b.key));
  const candidateStatementLines = statementLines.filter((s) => !isStatementLineMatched(s));

  const candidates: SuggestedMatch[] = [];
  for (const b of candidateBookLines) {
    if (!b.date) continue; // ไม่มีวันที่ (ไม่ควรเกิดกับรายการที่ผ่าน journal แล้ว) — เทียบไม่ได้ ข้าม
    for (const s of candidateStatementLines) {
      if (Math.abs(b.amount - s.amount) >= EPSILON) continue;
      const days = daysBetween(b.date, s.date);
      if (days === null || days > MATCH_MAX_DAYS_APART) continue;
      candidates.push({ bookLine: b, statementLine: s, daysApart: days });
    }
  }

  // เรียงใกล้วันที่สุดก่อน (0.17) — ใช้เป็นลำดับ greedy assignment กันคู่แนะนำซ้ำ book/statement line เดียวกัน
  candidates.sort((a, c) => a.daysApart - c.daysApart);

  const usedBookKeys = new Set<string>();
  const usedStatementIds = new Set<string>();
  const result: SuggestedMatch[] = [];
  for (const c of candidates) {
    if (usedBookKeys.has(c.bookLine.key) || usedStatementIds.has(c.statementLine.id)) continue;
    usedBookKeys.add(c.bookLine.key);
    usedStatementIds.add(c.statementLine.id);
    result.push(c);
  }
  return result;
}

// =======================================================================
// E) buildReconciliationSummary — pure (T50, 0.18)
// =======================================================================

export type ReconciliationSummary = {
  /** ยอดรวมฝั่งบัญชี (book) ทั้งหมด (signed) */
  bookBalance: number;
  /** ยอดรวมฝั่ง statement ทั้งหมด (signed) */
  statementBalance: number;
  unmatchedBookCount: number;
  unmatchedStatementCount: number;
  /** ยอดรวมฝั่งบัญชีที่ยังไม่จับคู่ */
  unmatchedBookTotal: number;
  /** ยอดรวมฝั่ง statement ที่ยังไม่จับคู่ */
  unmatchedStatementTotal: number;
  /** ผลต่างของยอดที่ยังไม่จับคู่ (unmatchedStatementTotal − unmatchedBookTotal) — ยังไม่ได้อธิบาย/บันทึกจริง */
  unmatchedDiff: number;
};

/** สรุปยอด book balance/statement balance/ผลต่างที่ยังไม่จับคู่ (0.18) — pure ล้วน ไม่แตะ DB */
export function buildReconciliationSummary(
  bookLines: BookLine[],
  statementLines: BankStatementLine[]
): ReconciliationSummary {
  const bookBalance = round2(bookLines.reduce((s, b) => s + b.amount, 0));
  const statementBalance = round2(statementLines.reduce((s, l) => s + l.amount, 0));

  const matchedBookKeys = new Set(
    statementLines.filter((s) => s.matchedBookLineKey).map((s) => s.matchedBookLineKey as string)
  );
  const unmatchedBook = bookLines.filter((b) => !matchedBookKeys.has(b.key));
  const unmatchedStatement = statementLines.filter((s) => !isStatementLineMatched(s));

  const unmatchedBookTotal = round2(unmatchedBook.reduce((s, b) => s + b.amount, 0));
  const unmatchedStatementTotal = round2(unmatchedStatement.reduce((s, l) => s + l.amount, 0));

  return {
    bookBalance,
    statementBalance,
    unmatchedBookCount: unmatchedBook.length,
    unmatchedStatementCount: unmatchedStatement.length,
    unmatchedBookTotal,
    unmatchedStatementTotal,
    unmatchedDiff: round2(unmatchedStatementTotal - unmatchedBookTotal),
  };
}

// =======================================================================
// F) data layer (DB) — T51
// =======================================================================

const LIST_LIMIT = 5000;
const BATCH_LIST_LIMIT = 200;

function asAmount(v: number | string): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? round2(n) : 0;
}

type RawStatementLine = {
  id: string;
  batch_id: string | null;
  stmt_date: string;
  description: string | null;
  amount: number | string;
  matched_book_line_key: string | null;
  matched_entry_id: string | null;
  matched_date: string | null;
  matched_amount: number | string | null;
  matched_at: string | null;
};

function mapStatementLine(r: RawStatementLine): BankStatementLine {
  return {
    id: r.id,
    batchId: r.batch_id,
    date: r.stmt_date,
    description: r.description,
    amount: asAmount(r.amount),
    matchedBookLineKey: r.matched_book_line_key,
    matchedEntryId: r.matched_entry_id,
    matchedDate: r.matched_date,
    matchedAmount: r.matched_amount == null ? null : asAmount(r.matched_amount),
    matchedAt: r.matched_at,
  };
}

const STATEMENT_LINE_SELECT =
  "id, batch_id, stmt_date, description, amount, matched_book_line_key, matched_entry_id, matched_date, matched_amount, matched_at";

/**
 * รายการ statement ของบัญชีเงินฝาก 1 บัญชี ในงวดที่เลือก (0.19) — เรียงวันที่ (เก่า→ใหม่)
 *   period ไม่ระบุ (from/to ว่าง) = ทั้งหมดที่มี (ยังไม่กรองงวด)
 */
export async function listStatementLines(
  db: DB,
  tenantId: string,
  customerId: string,
  bankAccountId: string,
  period?: Pick<ReportPeriod, "from" | "to">
): Promise<BankStatementLine[]> {
  let q = db
    .from("bank_statement_lines")
    .select(STATEMENT_LINE_SELECT)
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("bank_account_id", bankAccountId)
    .is("deleted_at", null)
    .order("stmt_date", { ascending: true })
    .limit(LIST_LIMIT);

  const from = validMonth(period?.from);
  const to = validMonth(period?.to);
  if (from) q = q.gte("stmt_date", `${from}-01`);
  if (to) {
    const [y, m] = to.split("-").map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    q = q.lt("stmt_date", `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`);
  }

  const { data, error } = await q;
  if (error || !data) return [];
  return (data as unknown as RawStatementLine[]).map(mapStatementLine);
}

/**
 * รายการ "ฝั่งบัญชี (book)" ของบัญชีเงินฝากที่เลือก ในงวดที่เลือก (0.14/0.19) — wrap
 *   buildJournalEntries(บิล) + flattenCombinedJournalLines(loadCombinedJournalLines(manual JE/
 *   bill_payments/CN-DN)) ของลูกค้ารายเดียวกัน แล้วกรองด้วย buildBookLines — ไม่มีสูตร/แหล่งข้อมูลคู่ขนานใหม่
 */
export async function listBookLines(
  db: DB,
  tenantId: string,
  customerId: string,
  accountCode: string,
  period: ReportPeriod,
  chartByCode: ChartByCode
): Promise<BookLine[]> {
  const { entries } = await listEntries(db, tenantId, { customerId });
  const filteredEntries = filterEntriesForReport(entries, period);
  const billLines = buildJournalEntries(filteredEntries, chartByCode).lines;

  const combined = await loadCombinedJournalLines(db, tenantId, entries, period, chartByCode);
  const combinedLines = flattenCombinedJournalLines(combined);

  return buildBookLines([...billLines, ...combinedLines], accountCode);
}

// ---------------------------------------------------------------------
// import batch (CSV) — T51
// ---------------------------------------------------------------------

export type ImportBatch = {
  id: string;
  customerId: string;
  bankAccountId: string;
  fileName: string | null;
  lineCount: number;
  importedAt: string;
};

type RawBatch = {
  id: string;
  customer_id: string;
  bank_account_id: string;
  file_name: string | null;
  line_count: number;
  imported_at: string;
};

function mapBatch(r: RawBatch): ImportBatch {
  return {
    id: r.id,
    customerId: r.customer_id,
    bankAccountId: r.bank_account_id,
    fileName: r.file_name,
    lineCount: r.line_count,
    importedAt: r.imported_at,
  };
}

/** ประวัติ batch ที่นำเข้าไว้ (ไม่ถูกลบ) ของบัญชีเงินฝาก 1 บัญชี — ล่าสุดก่อน (ใช้ในหน้า "ลบ batch ที่ผิด") */
export async function listBatches(
  db: DB,
  tenantId: string,
  customerId: string,
  bankAccountId: string
): Promise<ImportBatch[]> {
  const { data, error } = await db
    .from("bank_statement_import_batches")
    .select("id, customer_id, bank_account_id, file_name, line_count, imported_at")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("bank_account_id", bankAccountId)
    .is("deleted_at", null)
    .order("imported_at", { ascending: false })
    .limit(BATCH_LIST_LIMIT);
  if (error || !data) return [];
  return (data as unknown as RawBatch[]).map(mapBatch);
}

/** โหลด scope (customer_id/bank_account_id) ของ batch 1 ใบ — ใช้ตรวจสโคปก่อนลบที่ actions.ts ชั้นบน */
export async function getBatchScope(
  db: DB,
  tenantId: string,
  batchId: string
): Promise<{ customerId: string; bankAccountId: string } | null> {
  const { data } = await db
    .from("bank_statement_import_batches")
    .select("customer_id, bank_account_id")
    .eq("id", batchId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!data) return null;
  const r = data as { customer_id: string; bank_account_id: string };
  return { customerId: r.customer_id, bankAccountId: r.bank_account_id };
}

/** โหลด scope (customer_id/bank_account_id) ของ statement line 1 แถว — ใช้ตรวจสโคปก่อนแก้/ลบ/จับคู่ */
export async function getStatementLineScope(
  db: DB,
  tenantId: string,
  lineId: string
): Promise<{ customerId: string; bankAccountId: string } | null> {
  const { data } = await db
    .from("bank_statement_lines")
    .select("customer_id, bank_account_id")
    .eq("id", lineId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const r = data as { customer_id: string; bank_account_id: string };
  return { customerId: r.customer_id, bankAccountId: r.bank_account_id };
}

export type ImportCsvResult =
  | { ok: true; batchId: string; lineCount: number }
  | { ok: false; message: string };

/** จำนวนบรรทัดสูงสุดต่อไฟล์นำเข้า 1 ครั้ง (กันไฟล์ใหญ่ผิดปกติ) */
export const IMPORT_MAX_ROWS = 5000;

/**
 * นำเข้า statement จาก CSV ที่ parse แล้ว (parseBankStatementCsv) — สร้าง batch ใหม่ + bulk insert
 *   บรรทัดทั้งหมดผูก batch_id เดียวกัน (T51) — ถ้า insert บรรทัดล้ม ลบ batch ที่เพิ่งสร้างทิ้ง (กัน batch
 *   เปล่าไม่มีบรรทัดค้างใน DB)
 */
export async function importBatchFromCsv(
  db: DB,
  tenantId: string,
  customerId: string,
  bankAccountId: string,
  fileName: string | null,
  rows: ParsedStatementRow[]
): Promise<ImportCsvResult> {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, message: "ไฟล์ไม่มีข้อมูล (ไม่มีแถวให้นำเข้า)" };
  }
  if (rows.length > IMPORT_MAX_ROWS) {
    return { ok: false, message: `แถวมากเกินไป (สูงสุด ${IMPORT_MAX_ROWS} แถวต่อครั้ง)` };
  }

  const { data, error } = await db
    .from("bank_statement_import_batches")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      bank_account_id: bankAccountId,
      file_name: clampText(fileName, 200),
      line_count: rows.length,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "สร้าง batch นำเข้าไม่สำเร็จ กรุณาลองใหม่" };
  const batchId = (data as { id: string }).id;

  const { error: lineErr } = await db.from("bank_statement_lines").insert(
    rows.map((r) => ({
      tenant_id: tenantId,
      customer_id: customerId,
      bank_account_id: bankAccountId,
      batch_id: batchId,
      stmt_date: r.date,
      description: clampText(r.description, DESCRIPTION_MAX),
      amount: round2(r.amount),
    }))
  );
  if (lineErr) {
    // นำเข้าบรรทัดไม่สำเร็จ — ลบ batch ที่เพิ่งสร้างทิ้ง (กัน batch เปล่าค้าง)
    await db.from("bank_statement_import_batches").delete().eq("id", batchId).eq("tenant_id", tenantId);
    return { ok: false, message: "นำเข้าบรรทัด statement ไม่สำเร็จ กรุณาลองใหม่" };
  }

  return { ok: true, batchId, lineCount: rows.length };
}

/** ธุรกรรมดิบจาก deterministic parser (StatementTxn) — รับแบบ structural กัน import cycle */
type ReconTxnInput = {
  date: string | null;
  description?: string | null;
  counterparty_name?: string | null;
  direction: "in" | "out" | null;
  amount: number | null;
  /** เวลาโอน HH:MM (2026-09-01) — ติดไปใน description ของบรรทัดกระทบยอด */
  time?: string | null;
};

/**
 * สร้างบัญชีเงินฝากลูกค้าอัตโนมัติจากสเตทเมนต์ (ชื่อแบงก์)
 *   ★ parser ไม่มี "เลขบัญชี" ที่สะอาด (accountName = ชื่อเจ้าของ ไม่ใช่เลขบัญชี) → account_no = null
 *     (จับคู่/กันซ้ำด้วยชื่อแบงก์แทน) · เลือกรหัสผังเงินฝาก (bank:true) ตัวที่ลูกค้ายังไม่ได้ใช้
 */
async function ensureBankAccountFromStatement(
  db: DB,
  tenantId: string,
  customerId: string,
  bank: string | null,
  existing: CustomerBankAccount[]
): Promise<CustomerBankAccount | null> {
  const chart = await listChartOfAccounts(db, tenantId);
  const codes = bankAccountCodesOf(chart);
  if (codes.length === 0) return null;
  const used = new Set(existing.map((a) => a.accountCode));
  const code = codes.find((c: string) => !used.has(c)) ?? codes[0];
  const { data } = await db
    .from("customer_bank_accounts")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      account_code: code,
      bank_name: clampText(bank, 80),
      account_no: null,
    })
    .select("id, account_code, bank_name, account_no")
    .maybeSingle();
  if (!data) return null;
  const r = data as { id: string; account_code: string; bank_name: string | null; account_no: string | null };
  return { id: r.id, accountCode: r.account_code, bankName: r.bank_name, accountNo: r.account_no };
}

/**
 * ★ กันยอดเบิ้ล (พบจริง 2026-09-02): ลูกค้าส่งสเตทเมนต์ "ช่วงยาว" + "รายเดือน" ของบัญชีเดียวกัน
 *   → รายการเดียวกันอยู่ 2 ไฟล์ → dedup ด้วยชื่อไฟล์อย่างเดียวไม่พอ. ตัวกรองนี้เทียบ "รายรายการ"
 *   แบบ multiset: คีย์ วันที่|ยอด(ติดเครื่องหมาย)|คำอธิบาย — รายการที่มีอยู่ครบแล้วถูกตัดทิ้ง
 *   ส่วนรายการที่ซ้ำกันจริงในไฟล์เดียว (โอน 2 ครั้งเหมือนกันเป๊ะ) ยังผ่านครบ (นับเป็นจำนวน)
 *   pure — มี unit test ประกบ
 */
export function filterNewStatementRows(
  existing: { date: string; description: string | null; amount: number }[],
  incoming: ParsedStatementRow[]
): { kept: ParsedStatementRow[]; dropped: number } {
  const keyOf = (r: { date: string; description: string | null; amount: number }) =>
    `${r.date}|${round2(r.amount).toFixed(2)}|${(r.description ?? "").trim()}`;
  const counts = new Map<string, number>();
  for (const r of existing) {
    const k = keyOf(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const kept: ParsedStatementRow[] = [];
  let dropped = 0;
  for (const r of incoming) {
    const k = keyOf(r);
    const remain = counts.get(k) ?? 0;
    if (remain > 0) {
      counts.set(k, remain - 1); // มีอยู่แล้ว → ตัดทิ้ง (กินโควตาที่มี)
      dropped += 1;
    } else {
      kept.push(r);
    }
  }
  return { kept, dropped };
}

/**
 * ★ Auto-feed: สเตทเมนต์ที่ deterministic reconcile ผ่าน (มาทาง care OA) → insert เข้า bank_statement_lines
 *   ให้หน้ากระทบยอดมีธุรกรรมพร้อมจับคู่ทันที (ไม่ต้องอัป CSV ซ้ำ)
 *   ★ ลูกค้ายังไม่มีบัญชีเงินฝาก/ไม่ตรงแบงก์ → สร้างให้อัตโนมัติจากสเตทเมนต์ (ชื่อแบงก์+เลขบัญชี) · dedup ด้วย file_name
 *   ★ ยังคง "คนยืนยันจับคู่เสมอ" (ไม่ auto-confirm/auto-post) — แค่เตรียมข้อมูลให้
 */
export async function autoImportReconciledStatement(
  db: DB,
  params: {
    tenantId: string;
    customerId: string;
    bank: string | null;
    accountName?: string | null;
    transactions: ReconTxnInput[];
    sourceFileName: string | null;
  }
): Promise<{ imported: boolean; reason?: string; lineCount?: number }> {
  const { tenantId, customerId } = params;
  const accounts = await listCustomerBankAccounts(db, tenantId, customerId);

  // เลือกบัญชี: ชื่อแบงก์ตรง (มี ≥1 → ใช้ตัวแรก กันสร้างซ้ำ) > มีบัญชีเดียว > ไม่มี/ไม่ตรง → สร้างอัตโนมัติ
  let acct: CustomerBankAccount | null = null;
  if (params.bank) {
    const b = params.bank.toLowerCase();
    const hits = accounts.filter((a) => {
      const n = (a.bankName ?? "").toLowerCase();
      return n && (n.includes(b) || b.includes(n));
    });
    if (hits.length >= 1) acct = hits[0];
  }
  if (!acct && accounts.length === 1) acct = accounts[0];
  if (!acct) {
    acct = await ensureBankAccountFromStatement(db, tenantId, customerId, params.bank, accounts);
  }
  if (!acct) return { imported: false, reason: "cannot_resolve_bank_account" };

  // แปลงธุรกรรม → ParsedStatementRow (amount signed: เข้า=+ / ออก=−)
  const rows: ParsedStatementRow[] = params.transactions
    .filter((t) => t.date && t.amount != null && t.direction)
    .map((t) => {
      // ชื่อผู้โอนนำ + เวลาโอนต่อท้าย (ถ้ามี) — ให้หน้ากระทบยอดเห็น "ใคร โอนกี่โมง" ทันที
      const base = t.counterparty_name || t.description || null;
      const withTime = t.time ? `${base ?? "รายการ"} · โอน ${t.time} น.` : base;
      return {
        date: t.date as string,
        description: withTime,
        amount: t.direction === "out" ? -Math.abs(t.amount as number) : Math.abs(t.amount as number),
      };
    });
  if (rows.length === 0) return { imported: false, reason: "no_rows" };

  // dedup ชั้น 1: มี batch ของบัญชีนี้ที่ file_name เดียวกันแล้ว → ข้าม (กันสเตทเมนต์ใบเดิมเข้าซ้ำ)
  const sig = clampText(params.sourceFileName || `auto-${rows.length}-${rows[0].date}-${rows[rows.length - 1].date}`, 200);
  const { data: existing } = await db
    .from("bank_statement_import_batches")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("bank_account_id", acct.id)
    .eq("file_name", sig)
    .limit(1);
  if (existing && (existing as unknown[]).length > 0) return { imported: false, reason: "duplicate" };

  // dedup ชั้น 2 (2026-09-02): เทียบรายรายการกับแถวที่มีอยู่ในช่วงวันเดียวกัน — กันไฟล์
  //   "ช่วงยาว + รายเดือน" ของบัญชีเดียวกันทำยอดเบิ้ล (ชื่อไฟล์ต่างกัน ชั้น 1 จับไม่ได้)
  const dates = rows.map((r) => r.date).sort();
  const { data: existLines } = await db
    .from("bank_statement_lines")
    .select("stmt_date, description, amount")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("bank_account_id", acct.id)
    .gte("stmt_date", dates[0])
    .lte("stmt_date", dates[dates.length - 1])
    .limit(10000);
  const { kept, dropped } = filterNewStatementRows(
    ((existLines ?? []) as { stmt_date: string; description: string | null; amount: number }[]).map((l) => ({
      date: l.stmt_date,
      description: l.description,
      amount: l.amount,
    })),
    rows
  );
  if (kept.length === 0) return { imported: false, reason: "duplicate" };

  const res = await importBatchFromCsv(db, tenantId, customerId, acct.id, sig, kept);
  if (!res.ok) return { imported: false, reason: res.message };
  void dropped; // จำนวนที่ตัด — ผู้เรียกดูจาก lineCount เทียบ input ได้
  return { imported: true, lineCount: res.lineCount };
}

/**
 * ลบ batch (T49/T51) — hard-delete จริง (ไม่ soft-delete) → บรรทัด statement ที่ผูก batch นี้ถูกลบไปด้วย
 *   ตาม FK `bank_statement_lines.batch_id on delete cascade` (ใช้ตอน "ยกเลิกนำเข้า" ทันทีหลัง import ผิด
 *   ไฟล์ — ไม่ใช่ soft-delete ธุรกิจระยะยาว) — ไม่กระทบข้อมูลบัญชีจริงฝั่ง book เลย (การจับคู่/snapshot
 *   อยู่ที่ statement line เท่านั้น)
 */
export async function deleteBatch(
  db: DB,
  tenantId: string,
  batchId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await db.from("bank_statement_import_batches").delete().eq("id", batchId).eq("tenant_id", tenantId);
  if (error) return { ok: false, message: "ลบ batch ไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true };
}

// ---------------------------------------------------------------------
// กรอกมือ (T51)
// ---------------------------------------------------------------------

export type StatementLineResult = { ok: true; id: string } | { ok: false; message: string };

/** เพิ่มแถว statement กรอกมือ 1 แถว (batch_id = null — ไม่ผูก batch ไฟล์ใด) */
export async function addManualStatementLine(
  db: DB,
  tenantId: string,
  customerId: string,
  bankAccountId: string,
  input: { date: unknown; description?: unknown; amount: unknown }
): Promise<StatementLineResult> {
  const v = validateStatementLineInput(input);
  if (!v.ok) return { ok: false, message: v.message };

  const { data, error } = await db
    .from("bank_statement_lines")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      bank_account_id: bankAccountId,
      batch_id: null,
      stmt_date: v.value.date,
      description: v.value.description,
      amount: v.value.amount,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, message: "เพิ่มรายการไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true, id: (data as { id: string }).id };
}

/** ลบ statement line 1 แถว (soft-delete — ต่างจาก deleteBatch ที่ hard-delete ทั้งชุด) */
export async function deleteStatementLine(
  db: DB,
  tenantId: string,
  lineId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await db
    .from("bank_statement_lines")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", lineId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ลบรายการไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true };
}

// ---------------------------------------------------------------------
// จับคู่ (0.15/0.17) — confirmMatch เขียน snapshot, unmatch เคลียร์กลับเป็น null
// ---------------------------------------------------------------------

/**
 * ยืนยันจับคู่ 1 คู่ (0.15/0.17) — เขียน snapshot 4 ฟิลด์ (matched_book_line_key/matched_entry_id/
 *   matched_date/matched_amount) + matched_at = now() ★ ต้องกดยืนยันทีละคู่เสมอ (caller ชั้น action
 *   เรียกทีละ statementLineId เท่านั้น — ไม่มี bulk auto-confirm)
 */
export async function confirmMatch(
  db: DB,
  tenantId: string,
  statementLineId: string,
  bookLine: Pick<BookLine, "key" | "entryId" | "date" | "amount">
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await db
    .from("bank_statement_lines")
    .update({
      matched_book_line_key: bookLine.key,
      matched_entry_id: bookLine.entryId,
      matched_date: bookLine.date,
      matched_amount: bookLine.amount,
      matched_at: new Date().toISOString(),
    })
    .eq("id", statementLineId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ยืนยันจับคู่ไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true };
}

/** ยกเลิกจับคู่ (0.16) — เคลียร์ snapshot ทั้ง 4 ฟิลด์ + matched_at กลับเป็น null ทั้งหมด */
export async function unmatch(
  db: DB,
  tenantId: string,
  statementLineId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await db
    .from("bank_statement_lines")
    .update({
      matched_book_line_key: null,
      matched_entry_id: null,
      matched_date: null,
      matched_amount: null,
      matched_at: null,
    })
    .eq("id", statementLineId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (error) return { ok: false, message: "ยกเลิกจับคู่ไม่สำเร็จ กรุณาลองใหม่" };
  return { ok: true };
}
