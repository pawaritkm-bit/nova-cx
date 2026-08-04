/**
 * สมุดรายวัน 5 เล่ม (ซื้อ / ขาย / จ่าย / รับ / ทั่วไป) — ตัวจัดเล่ม (pure, เทสต์ได้)
 *
 * ต่อยอดจาก buildJournalEntries (lib/accounting/journal.ts) ที่คำนวณ double-entry เดบิต/เครดิต
 * ต่อบิลไว้แล้ว (และการันตี "เดบิตรวม = เครดิตรวม" ต่อบิล). ไฟล์นี้ทำแค่ 2 อย่าง:
 *   1) จับกลุ่ม journal lines กลับเป็น "ใบสำคัญ" (posting) ต่อบิล — เพื่อโชว์เดบิต/เครดิตคู่กัน
 *   2) แยกแต่ละใบสำคัญเข้า "เล่ม" ตามกติกา (classifyBook)
 *
 * ★★ สมมติฐานบัญชี (ต้องให้นักบัญชียืนยัน) ★★
 *   A) การจัดเล่มเป็นแบบ "แบ่งเด็ดขาด (partition)" — 1 บิล → เข้าเล่มเดียวเท่านั้น (กัน double count).
 *      นี่คือหัวใจของ "สมุดรายวันเฉพาะ" (special journals). กติกา:
 *        - ซื้อ + จ่ายเงินสด/โอน      → "สมุดรายวันจ่ายเงิน"  (จ่ายจริงทันที)
 *        - ซื้อ + เชื่อ/เช็คล่วงหน้า    → "สมุดรายวันซื้อ"      (ตั้งเจ้าหนี้/เช็คสั่งจ่าย)
 *        - ขาย + รับเงินสด/โอน       → "สมุดรายวันรับเงิน"   (รับจริงทันที)
 *        - ขาย + เชื่อ/เช็คล่วงหน้า     → "สมุดรายวันขาย"       (ตั้งลูกหนี้/เช็ครับ)
 *        - อื่น ๆ (รายการปรับปรุง)     → "สมุดรายวันทั่วไป"
 *      ★ ทางเลือกอื่นที่นักบัญชีอาจใช้: เล่มซื้อ/ขาย = "ทุกบิลซื้อ/ขาย" แล้วเล่มจ่าย/รับ = ตอนชำระ
 *        (จะ post 2 ครั้ง: ตอนตั้งหนี้ + ตอนจ่าย). ระบบเรายังไม่แยก "รายการชำระ" ออกจากบิล
 *        จึงเลือกแบบ partition ไปก่อน — ★ ต้องยืนยัน.
 *   B) #10 "ฝั่งขายไม่วิ่งสมุดรายวัน(ทั่วไป)": ตีความว่า "บิลขายไม่ตกลงสมุดรายวันทั่วไป"
 *      (เพราะบันทึกในเล่มขาย/รับเงินแยกแล้ว — กันซ้ำ). classifyBook จึงไม่มีทางคืน 'general'
 *      ให้บิลขาย. ★ อีกความเป็นไปได้ (ขายไม่ post เข้าสมุดรายวันเลย) ยังไม่ทำ — ต้องยืนยัน.
 *   C) การ map บัญชีเดบิต/เครดิต (บัญชีคู่จากวิธีรับ/จ่ายเงิน) ใช้กติกาเดียวกับ journal.ts
 *      (contraAccountFor) — ดูสมมติฐานในไฟล์นั้น.
 *
 * ★ pure ล้วน · PDPA: ไม่ log ชื่อ/เลขภาษี/ตัวเลข
 */
import { round2, type BillEntry, type PaymentMethod } from "@/lib/accounting/queries";
import { buildJournalEntries, type SkippedEntry } from "@/lib/accounting/journal";

/** เล่มสมุดรายวัน 5 เล่ม */
export type BookKind = "purchase" | "sale" | "payment" | "receipt" | "general";

/** ป้ายชื่อเล่ม (ไทย) */
export const BOOK_LABELS: Record<BookKind, string> = {
  purchase: "สมุดรายวันซื้อ",
  sale: "สมุดรายวันขาย",
  payment: "สมุดรายวันจ่ายเงิน",
  receipt: "สมุดรายวันรับเงิน",
  general: "สมุดรายวันทั่วไป",
};

/** ลำดับการแสดงผล 5 เล่ม */
export const BOOK_ORDER: BookKind[] = ["purchase", "sale", "payment", "receipt", "general"];

/** วิธีจ่าย/รับ ที่ถือเป็น "จ่าย/รับเงินจริงทันที" → เข้าเล่มจ่าย/รับ (ที่เหลือ = เชื่อ → เล่มซื้อ/ขาย) */
const CASH_METHODS: ReadonlySet<PaymentMethod> = new Set<PaymentMethod>(["cash", "transfer"]);

/**
 * จัดบิล 1 ใบเข้าเล่ม (กติกา partition — ดูสมมติฐาน A/B)
 *   ★ บิลขายไม่มีทางคืน 'general' (กติกา B #10)
 */
export function classifyBook(
  entryType: BillEntry["entryType"],
  paymentMethod: PaymentMethod | null
): BookKind {
  const paysCash = !!paymentMethod && CASH_METHODS.has(paymentMethod);
  if (entryType === "purchase") return paysCash ? "payment" : "purchase";
  if (entryType === "sale") return paysCash ? "receipt" : "sale";
  // unspecified/อื่น ๆ → ทั่วไป (แต่ในทางปฏิบัติ journal.ts กรอง unspecified ออกก่อนแล้ว)
  return "general";
}

/** บรรทัดบัญชีในใบสำคัญ (ฝั่งเดียว) */
export type PostingLeg = { accountCode: string; accountName: string; amount: number };

/** ใบสำคัญ (posting) ต่อบิล 1 ใบ — เดบิต/เครดิต แยกฝั่ง (สมดุลแล้วจาก journal.ts) */
export type JournalPosting = {
  entryId: string;
  date: string | null;
  docNo: string | null;
  /** คำอธิบาย (ชื่อคู่ค้า) */
  description: string;
  debits: PostingLeg[];
  credits: PostingLeg[];
  totalDebit: number;
  totalCredit: number;
  book: BookKind;
};

/** 1 เล่ม = ชุดใบสำคัญ + ยอดรวมเดบิต/เครดิต (ต้องเท่ากัน) */
export type JournalBook = {
  kind: BookKind;
  label: string;
  postings: JournalPosting[];
  totalDebit: number;
  totalCredit: number;
};

export type JournalBooksResult = {
  books: Record<BookKind, JournalBook>;
  /** บิลที่ลงบัญชีไม่ได้ (จาก journal.ts) — โชว์เตือนให้นักบัญชีไปแก้ */
  skipped: SkippedEntry[];
};

/** เรียงใบสำคัญตามวันที่ (เก่า→ใหม่) · ไม่มีวันที่ = ท้าย · เท่ากันเรียงต่อด้วยเลขที่ */
function byDateAsc(a: JournalPosting, b: JournalPosting): number {
  if (a.date && b.date) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  } else if (a.date) {
    return -1;
  } else if (b.date) {
    return 1;
  }
  return (a.docNo ?? "").localeCompare(b.docNo ?? "", "th");
}

/**
 * สร้างสมุดรายวัน 5 เล่มจากบิลทั้งชุด
 *   - ใช้ buildJournalEntries คำนวณเดบิต/เครดิต (สมดุลต่อบิล) + คัดบิลที่ลงไม่ได้ (skipped)
 *   - จับกลุ่ม lines กลับเป็นใบสำคัญต่อบิล แล้วแยกเข้าเล่มตาม classifyBook
 *   ผู้เรียกควรกรอง customer + month มาก่อน (ผ่าน listEntries)
 */
export function buildJournalBooks(entries: BillEntry[]): JournalBooksResult {
  const { lines, skipped } = buildJournalEntries(entries);

  // map entryId → entry (เอา entryType/paymentMethod มาจัดเล่ม)
  const entryById = new Map<string, BillEntry>();
  for (const e of entries) entryById.set(e.id, e);

  // จับกลุ่ม journal lines → posting ต่อ entryId (คงลำดับที่ journal.ts push มา: เดบิตก่อนเครดิต)
  const postingByEntry = new Map<string, JournalPosting>();
  for (const l of lines) {
    let p = postingByEntry.get(l.entryId);
    if (!p) {
      const e = entryById.get(l.entryId);
      p = {
        entryId: l.entryId,
        date: l.date,
        docNo: l.docNo,
        description: (l.counterparty ?? "").trim(),
        debits: [],
        credits: [],
        totalDebit: 0,
        totalCredit: 0,
        book: classifyBook(e?.entryType ?? "unspecified", e?.paymentMethod ?? null),
      };
      postingByEntry.set(l.entryId, p);
    }
    if (l.side === "debit") {
      p.debits.push({ accountCode: l.accountCode, accountName: l.accountName, amount: l.debit });
      p.totalDebit = round2(p.totalDebit + l.debit);
    } else {
      p.credits.push({ accountCode: l.accountCode, accountName: l.accountName, amount: l.credit });
      p.totalCredit = round2(p.totalCredit + l.credit);
    }
  }

  // เตรียม 5 เล่มเปล่า
  const books: Record<BookKind, JournalBook> = {
    purchase: emptyBook("purchase"),
    sale: emptyBook("sale"),
    payment: emptyBook("payment"),
    receipt: emptyBook("receipt"),
    general: emptyBook("general"),
  };

  for (const p of postingByEntry.values()) {
    const book = books[p.book];
    book.postings.push(p);
    book.totalDebit = round2(book.totalDebit + p.totalDebit);
    book.totalCredit = round2(book.totalCredit + p.totalCredit);
  }

  for (const k of BOOK_ORDER) books[k].postings.sort(byDateAsc);

  return { books, skipped };
}

function emptyBook(kind: BookKind): JournalBook {
  return { kind, label: BOOK_LABELS[kind], postings: [], totalDebit: 0, totalCredit: 0 };
}

/**
 * zip เดบิต/เครดิตของใบสำคัญเป็นแถวแสดงผล (บัญชีเดบิต|เดบิต|บัญชีเครดิต|เครดิต)
 *   - จำนวนแถว = max(จำนวนเดบิต, จำนวนเครดิต) · ฝั่งที่หมดก่อนเว้นว่าง
 *   - ให้ UI โง่ ๆ (เดินลูป render) · เทสต์ความถูกต้องได้ที่นี่
 */
export type BookDisplayRow = {
  debit: PostingLeg | null;
  credit: PostingLeg | null;
};

export function zipPosting(p: JournalPosting): BookDisplayRow[] {
  const n = Math.max(p.debits.length, p.credits.length);
  const rows: BookDisplayRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({ debit: p.debits[i] ?? null, credit: p.credits[i] ?? null });
  }
  return rows;
}
