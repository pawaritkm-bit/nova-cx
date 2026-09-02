/**
 * สมุดรายวัน 5 เล่ม (ซื้อ / ขาย / จ่าย / รับ / ทั่วไป) — ตัวจัดเล่ม (pure, เทสต์ได้)
 *
 * ต่อยอดจาก buildJournalEntries (lib/accounting/journal.ts) ที่คำนวณ double-entry เดบิต/เครดิต
 * ต่อบิลไว้แล้ว (และการันตี "เดบิตรวม = เครดิตรวม" ต่อบิล). ไฟล์นี้ทำแค่ 2 อย่าง:
 *   1) จับกลุ่ม journal lines กลับเป็น "ใบสำคัญ" (posting) ต่อบิล — เพื่อโชว์เดบิต/เครดิตคู่กัน
 *   2) แยกแต่ละใบสำคัญเข้า "เล่ม" ตามกติกา (classifyBook)
 *
 * ★★ สมมติฐานบัญชี (ต้องให้นักบัญชียืนยัน) ★★
 *   A) จัดเล่มตาม "ชนิดเอกสาร" (ผู้ใช้ยืนยัน 2026-08-04): บิลซื้อทุกใบ → สมุดรายวันซื้อ,
 *      บิลขายทุกใบ → สมุดรายวันขาย (ไม่แยกตามวิธีชำระ). 1 บิล → เข้าเล่มเดียว (กัน double count).
 *      ★ เล่มรับเงิน/จ่ายเงิน = เงินสดเข้า-ออกจริง — บิลปกติไม่ post มาที่เล่มนี้ (บิลไม่มีแนวคิด receipt/
 *        payment voucher ของตัวเอง) ★ เฟส 1 ส่วน C (docs/06 หมวด 0.8) แก้ TODO เดิมนี้แล้ว: manual
 *        journal entry (JV/PV/RV, lib/accounting/manual-journal.ts) คือ data source ที่ feed 2 เล่มนี้
 *        — PV (ใบสำคัญจ่ายเงิน) → เล่มจ่ายเงิน, RV (ใบสำคัญรับเงิน) → เล่มรับเงิน, JV → เล่มทั่วไป
 *        ผสมเข้าผ่านพารามิเตอร์ manualPostings ของ buildJournalBooks() ด้านล่าง (ไม่ผ่าน billEntry เลย)
 *   B) #10 "ฝั่งขายไม่วิ่งสมุดรายวัน(ทั่วไป)": บิลขายไม่ตกสมุดรายวันทั่วไป (อยู่เล่มขาย).
 *      classifyBook ไม่มีทางคืน 'general' ให้บิลขาย.
 *   C) การ map บัญชีเดบิต/เครดิต (บัญชีคู่จากวิธีรับ/จ่ายเงิน) ใช้กติกาเดียวกับ journal.ts
 *      (contraAccountFor) — ดูสมมติฐานในไฟล์นั้น.
 *
 * ★ pure ล้วน · PDPA: ไม่ log ชื่อ/เลขภาษี/ตัวเลข
 */
import { round2, type BillEntry, type PaymentMethod } from "@/lib/accounting/queries";
import { buildJournalEntries, type SkippedEntry } from "@/lib/accounting/journal";
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";

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

/**
 * เล่มที่จะแสดง จากตัวเลือกฝั่ง UI
 *   - "all" (หรือค่าไม่รู้จัก) → ครบ 5 เล่มตาม BOOK_ORDER
 *   - ค่าตรงกับ BookKind → เล่มนั้นเล่มเดียว
 *   (ใช้ทั้งบนจอและตอนพิมพ์ → พิมพ์เฉพาะเล่มที่เลือก)
 */
export function visibleBooks(selected: string): BookKind[] {
  return (BOOK_ORDER as string[]).includes(selected)
    ? [selected as BookKind]
    : BOOK_ORDER;
}

/**
 * จัดบิล 1 ใบเข้าเล่ม — ★ ตามที่ผู้ใช้ยืนยัน: บิลซื้อ/ขาย "ทุกใบ" เข้าเล่มซื้อ/ขายตามชนิดเอกสาร
 *   (สมุดรายวันเฉพาะแบบยึด "ชนิดเอกสาร" — ไม่แยกตามวิธีชำระ)
 *   - บิลซื้อทุกใบ (เงินสด/โอน/เชื่อ) → สมุดรายวันซื้อ
 *   - บิลขายทุกใบ                    → สมุดรายวันขาย   (#10: ไม่ตกเล่มทั่วไป)
 *   - อื่น ๆ (รายการปรับปรุง)          → สมุดรายวันทั่วไป
 *   ★ เล่มรับเงิน/จ่ายเงิน = เงินสดเข้า-ออกจริง (จะมาจากสเตทเมนต์ภายหลัง — ยังไม่ post จากบิล)
 */
export function classifyBook(
  entryType: BillEntry["entryType"],
  paymentMethod: PaymentMethod | null
): BookKind {
  // ★ 2026-09-02 ผู้ใช้ยืนยันกติกาบัญชีมาตรฐาน (แทนกติกาเดิม 2026-08-04 ที่จัดตามชนิดเอกสารล้วน):
  //   บิลที่ "รับ/จ่ายเงินแล้ว" (เงินสด/โอน) → เล่มรับเงิน (ขาย) / เล่มจ่ายเงิน (ซื้อ)
  //   บิลเชื่อ/ยังไม่ระบุวิธีชำระ (ตั้งลูกหนี้-เจ้าหนี้) → เล่มขาย / เล่มซื้อ ตามเดิม
  //   ใบละเล่มเดียวเหมือนเดิม (ไม่นับซ้ำ) — ยอดรวมงบไม่เปลี่ยน แค่ย้ายเล่ม
  const paid = paymentMethod === "cash" || paymentMethod === "transfer";
  if (entryType === "purchase") return paid ? "payment" : "purchase";
  if (entryType === "sale") return paid ? "receipt" : "sale";
  // unspecified/อื่น ๆ → ทั่วไป (ในทางปฏิบัติ journal.ts กรอง unspecified ออกก่อนแล้ว)
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
 * สร้างสมุดรายวัน 5 เล่มจากบิลทั้งชุด + manual JE (เฟส 1 ส่วน C, 0.8)
 *   - ใช้ buildJournalEntries คำนวณเดบิต/เครดิต (สมดุลต่อบิล) + คัดบิลที่ลงไม่ได้ (skipped)
 *   - จับกลุ่ม lines กลับเป็นใบสำคัญต่อบิล แล้วแยกเข้าเล่มตาม classifyBook
 *   - manualPostings (จาก manual-journal.ts::toJournalPosting — สมดุลแล้วต่อใบ) ผสมเข้าเล่มตรง ๆ
 *     ตาม posting.book ที่ระบุมา (JV→ทั่วไป, PV→จ่ายเงิน, RV→รับเงิน) ★ แก้ TODO เดิม: เล่มรับ/จ่ายเงิน
 *     เคยว่างเปล่าเพราะไม่มีข้อมูลจากบิล — manual JE คือ data source ที่ TODO นี้รออยู่พอดี
 *   ผู้เรียกควรกรอง customer + month มาก่อน (ผ่าน listEntries / listManualEntries + filterManualEntriesForReport)
 *   @param chartByCode ผังบัญชีของ tenant — default {} เพื่อ backward-compat ระดับ compile
 *     (ผู้เรียกจริงควรส่งของจริงมา ไม่งั้นชื่อบัญชีของ VAT/WHT/บัญชีคู่ synthetic จะ fallback เป็นแค่รหัส)
 * @param manualPostings ใบสำคัญจาก manual JE ที่ "ยืนยันแล้ว" (caller กรองตาม status/งวดก่อนส่งเข้ามา)
 */
export function buildJournalBooks(
  entries: BillEntry[],
  chartByCode: ChartByCode = {},
  manualPostings: JournalPosting[] = []
): JournalBooksResult {
  const { lines, skipped } = buildJournalEntries(entries, chartByCode);

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

  // manual JE — ผสมเข้าเล่มตาม posting.book ตรง ๆ (คำนวณ/สมดุลมาแล้วจาก manual-journal.ts)
  for (const p of manualPostings) {
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
