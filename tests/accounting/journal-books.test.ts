import { describe, it, expect } from "vitest";
import type { BillEntry, BillEntryLine, PaymentMethod } from "@/lib/accounting/queries";
import {
  classifyBook,
  buildJournalBooks,
  zipPosting,
  visibleBooks,
  BOOK_ORDER,
  type JournalPosting,
} from "@/lib/accounting/journal-books";
import { toJournalPosting, type ManualJournalEntry } from "@/lib/accounting/manual-journal";
import { toJournalPosting as toNoteJournalPosting, type CreditDebitNote } from "@/lib/accounting/credit-debit-notes";

function mkLine(p: Partial<BillEntryLine>): BillEntryLine {
  return {
    id: Math.random().toString(36).slice(2), entryId: "e", lineNo: 1, vatType: "vat",
    description: null, accountCode: null, accountName: null, amount: 0, vatAmount: 0,
    whtRate: 0, whtAmount: 0, aiFilled: false, aiLowConfidence: false, ...p,
  };
}
function mkEntry(p: Partial<BillEntry> & { id: string }): BillEntry {
  return {
    id: p.id, tenantId: "t", attachmentId: null, customerId: "c1", customerName: null,
    attachmentObjectPath: null, uploadPath: null, uploadName: null, uploadMime: null,
    entryType: p.entryType ?? "purchase", docDate: p.docDate ?? "2026-07-05", docNo: p.docNo ?? "DOC-1",
    counterpartyName: p.counterpartyName ?? "คู่ค้า", counterpartyTaxId: null,
    sellerName: null, sellerTaxId: null, buyerName: null, buyerTaxId: null,
    whtForm: null, paymentMethod: p.paymentMethod ?? "credit",
    paymentBankAccountId: null, paymentBankAccountCode: null,
    dueDate: p.dueDate ?? null,
    status: "confirmed", source: "ai", aiConfidence: null, notes: null,
    createdAt: "2026-07-01T00:00:00Z", confirmedAt: null,
    inputTaxMonth: null,    lines: p.lines ?? [],
  };
}

// ---------------------------------------------------------------------
describe("journal-books: classifyBook (★★ 2026-09-03 หลักบัญชีมาตรฐาน 2 ขา — 'ตอนนี้ในระบบลงผิดอยู่')", () => {
  it("ขาตั้งหนี้ (invoice): บิลซื้อทุกใบ → เล่มซื้อ · บิลขายทุกใบ → เล่มขาย", () => {
    expect(classifyBook("purchase", "invoice")).toBe("purchase");
    expect(classifyBook("sale", "invoice")).toBe("sale");
  });
  it("ขาตัดชำระ (settlement): ซื้อ → เล่มจ่ายเงิน (Dr เจ้าหนี้/Cr เงิน) · ขาย → เล่มรับเงิน (Dr เงิน/Cr ลูกหนี้)", () => {
    expect(classifyBook("purchase", "settlement")).toBe("payment");
    expect(classifyBook("sale", "settlement")).toBe("receipt");
  });

  // ★ #10: บิลขายห้ามตกเล่ม "ทั่วไป" — ทุกขา ต้องไม่ใช่ general
  it("#10 ขายไม่วิ่งสมุดรายวันทั่วไป (ทุกขา)", () => {
    expect(classifyBook("sale", "invoice")).not.toBe("general");
    expect(classifyBook("sale", "settlement")).not.toBe("general");
  });

  it("unspecified → ทั่วไป", () => {
    expect(classifyBook("unspecified", "invoice")).toBe("general");
  });
});

// ---------------------------------------------------------------------
describe("journal-books: buildJournalBooks (post เข้าเล่ม + เดบิต=เครดิต)", () => {
  it("ซื้อเชื่อเข้าเล่มซื้อ · เดบิต=เครดิต", () => {
    const entries = [
      mkEntry({
        id: "p1", entryType: "purchase", paymentMethod: "credit",
        lines: [mkLine({ accountCode: "5010", accountName: "ซื้อสินค้า", amount: 1000, vatAmount: 70 })],
      }),
    ];
    const { books } = buildJournalBooks(entries);
    expect(books.purchase.postings).toHaveLength(1);
    expect(books.payment.postings).toHaveLength(0);
    // เดบิต = ซื้อ 1000 + ภาษีซื้อ 70 = 1070 ; เครดิต = เจ้าหนี้ 1070
    expect(books.purchase.totalDebit).toBe(1070);
    expect(books.purchase.totalCredit).toBe(1070);
    const p = books.purchase.postings[0];
    expect(p.totalDebit).toBe(p.totalCredit);
    expect(p.credits.some((c) => c.accountCode === "2010")).toBe(true); // เจ้าหนี้การค้า
  });

  it("★ 2026-09-03 ซื้อเงินสด → เข้า 2 เล่ม: เล่มซื้อ (ตั้งหนี้) + เล่มจ่ายเงิน (ตัดชำระ)", () => {
    const entries = [
      mkEntry({
        id: "p2", entryType: "purchase", paymentMethod: "cash",
        lines: [mkLine({ accountCode: "5340", accountName: "ค่าน้ำมัน", amount: 500, vatAmount: 35 })],
      }),
    ];
    const { books } = buildJournalBooks(entries);
    // เล่มซื้อ: Dr 5340 500 + Dr ภาษีซื้อ 35 / Cr เจ้าหนี้ 535
    expect(books.purchase.postings).toHaveLength(1);
    expect(books.purchase.postings[0].credits.some((c) => c.accountCode === "2010")).toBe(true);
    expect(books.purchase.totalDebit).toBe(535);
    // เล่มจ่ายเงิน: Dr เจ้าหนี้ 535 / Cr เงินสด 535
    expect(books.payment.postings).toHaveLength(1);
    expect(books.payment.postings[0].debits.some((d) => d.accountCode === "2010")).toBe(true);
    expect(books.payment.postings[0].credits.some((c) => c.accountCode === "1010")).toBe(true);
    expect(books.payment.totalDebit).toBe(535);
    expect(books.payment.totalDebit).toBe(books.payment.totalCredit);
    // คำอธิบายขาตัดชำระบอกชัดว่าเป็นการชำระ
    expect(books.payment.postings[0].description).toContain("จ่ายชำระ");
  });

  it("ขายเชื่อ → เล่มขายขาเดียว · ขายเงินสด → เล่มขาย (ตั้งลูกหนี้) + เล่มรับเงิน (ตัดลูกหนี้) · ทั่วไปว่าง", () => {
    const entries = [
      mkEntry({ id: "s1", entryType: "sale", paymentMethod: "credit",
        lines: [mkLine({ accountCode: "4010", accountName: "ขายสินค้า", amount: 1000, vatAmount: 70 })] }),
      mkEntry({ id: "s2", entryType: "sale", paymentMethod: "cash",
        lines: [mkLine({ accountCode: "4010", accountName: "ขายสินค้า", amount: 2000, vatAmount: 140 })] }),
    ];
    const { books } = buildJournalBooks(entries);
    expect(books.sale.postings).toHaveLength(2); // ทั้งสองใบตั้งลูกหนี้ในเล่มขาย
    expect(books.receipt.postings).toHaveLength(1); // เฉพาะใบเงินสดมีขารับชำระ
    const rc = books.receipt.postings[0];
    expect(rc.debits.some((d) => d.accountCode === "1010")).toBe(true); // Dr เงินสด
    expect(rc.credits.some((c) => c.accountCode === "1140")).toBe(true); // Cr ลูกหนี้
    expect(rc.description).toContain("รับชำระ");
    expect(books.general.postings).toHaveLength(0); // #10: ขายไม่เข้าทั่วไป
  });

  it("ทุกเล่มมี เดบิตรวม = เครดิตรวม", () => {
    const entries = [
      mkEntry({ id: "p1", entryType: "purchase", paymentMethod: "credit",
        lines: [mkLine({ accountCode: "5010", amount: 1000, vatAmount: 70 })] }),
      mkEntry({ id: "p2", entryType: "purchase", paymentMethod: "cash",
        lines: [mkLine({ accountCode: "5340", amount: 500, vatAmount: 35 })] }),
      mkEntry({ id: "s1", entryType: "sale", paymentMethod: "credit",
        lines: [mkLine({ accountCode: "4010", amount: 3000, vatAmount: 210 })] }),
      mkEntry({ id: "s2", entryType: "sale", paymentMethod: "transfer", paymentBankAccountCode: "1020",
        lines: [mkLine({ accountCode: "4010", amount: 800, vatAmount: 56 })] }),
    ];
    const { books } = buildJournalBooks(entries);
    for (const k of BOOK_ORDER) {
      expect(books[k].totalDebit).toBe(books[k].totalCredit);
    }
  });

  it("บิลที่ลงไม่ได้ (ยังไม่ระบุประเภท) → เข้า skipped ไม่เข้าเล่มใด", () => {
    const entries = [
      mkEntry({ id: "u1", entryType: "unspecified",
        lines: [mkLine({ accountCode: "5010", amount: 100 })] }),
    ];
    const { books, skipped } = buildJournalBooks(entries);
    expect(skipped.length).toBe(1);
    for (const k of BOOK_ORDER) expect(books[k].postings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// เฟส 1 ส่วน C (0.8, ⚠️ FLAG): manual JE (JV/PV/RV) merge เข้าเล่มตาม doc_type
//   ★ แก้ TODO เดิม: เล่มรับ/จ่ายเงินเคยว่างเปล่าเพราะบิลไม่มีแนวคิด receipt/payment voucher ของตัวเอง
function mkManualEntry(p: Partial<ManualJournalEntry> & { id: string }): ManualJournalEntry {
  return {
    id: p.id,
    tenantId: "t",
    customerId: "c1",
    docType: p.docType ?? "JV",
    docDate: p.docDate ?? "2026-07-15",
    docNo: p.docNo ?? null,
    memo: p.memo ?? null,
    status: p.status ?? "confirmed",
    createdAt: "2026-07-15T00:00:00Z",
    confirmedAt: "2026-07-15T00:00:00Z",
    lines: p.lines ?? [
      { id: "l1", lineNo: 1, accountCode: "5370", accountName: "ค่าเสื่อมราคา-อาคาร", description: null, debit: 500, credit: 0 },
      { id: "l2", lineNo: 2, accountCode: "1615.1", accountName: "ค่าเสื่อมสะสม-อาคาร", description: null, debit: 0, credit: 500 },
    ],
  };
}

describe("journal-books: buildJournalBooks + manualPostings (0.8 — เล่มรับ/จ่ายเงินไม่ว่างเปล่าอีกต่อไป)", () => {
  it("manual JE doc_type='PV' → โผล่ในเล่ม \"สมุดรายวันจ่ายเงิน\" (ที่เคยว่างเปล่า)", () => {
    const manual = toJournalPosting(mkManualEntry({ id: "pv1", docType: "PV" }));
    const { books } = buildJournalBooks([], {}, [manual]);
    expect(books.payment.postings).toHaveLength(1);
    expect(books.payment.totalDebit).toBe(500);
    expect(books.payment.totalCredit).toBe(500);
  });

  it("manual JE doc_type='RV' → โผล่ในเล่ม \"สมุดรายวันรับเงิน\"", () => {
    const manual = toJournalPosting(mkManualEntry({ id: "rv1", docType: "RV" }));
    const { books } = buildJournalBooks([], {}, [manual]);
    expect(books.receipt.postings).toHaveLength(1);
    expect(books.receipt.totalDebit).toBe(500);
    expect(books.receipt.totalCredit).toBe(500);
  });

  it("manual JE doc_type='JV' → โผล่ในเล่ม \"สมุดรายวันทั่วไป\"", () => {
    const manual = toJournalPosting(mkManualEntry({ id: "jv1", docType: "JV" }));
    const { books } = buildJournalBooks([], {}, [manual]);
    expect(books.general.postings).toHaveLength(1);
  });

  it("ผสมบิลจริง + manual JE ในเล่มเดียวกัน → ยอดรวมยังสมดุล (เดบิต=เครดิต ทุกเล่ม)", () => {
    const entries = [
      mkEntry({
        id: "p1",
        entryType: "purchase",
        paymentMethod: "credit",
        lines: [mkLine({ accountCode: "5010", amount: 1000, vatAmount: 70 })],
      }),
    ];
    const manualPv = toJournalPosting(mkManualEntry({ id: "pv1", docType: "PV" }));
    const manualJv = toJournalPosting(mkManualEntry({ id: "jv1", docType: "JV" }));
    const { books } = buildJournalBooks(entries, {}, [manualPv, manualJv]);
    for (const k of BOOK_ORDER) {
      expect(books[k].totalDebit).toBe(books[k].totalCredit);
    }
    // เล่มซื้อยังมีแค่บิลจริง (manual ไม่ปนเข้าเล่มซื้อ)
    expect(books.purchase.postings).toHaveLength(1);
    expect(books.payment.postings).toHaveLength(1);
    expect(books.general.postings).toHaveLength(1);
  });

  it("ไม่ส่ง manualPostings (default []) → บิลยังจัดเล่มปกติ (★ 2026-09-02: ซื้อเงินสด → เล่มจ่ายเงิน)", () => {
    const entries = [
      mkEntry({ id: "p1", entryType: "purchase", paymentMethod: "cash",
        lines: [mkLine({ accountCode: "5010", amount: 500 })] }),
    ];
    const { books } = buildJournalBooks(entries);
    expect(books.payment.postings).toHaveLength(1);
    expect(books.receipt.postings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// เฟส 3 ส่วน J (0.7, J10) — notePostings (CN/DN) ผสมเข้าเล่ม sale/purchase ตามฝั่งบิลเดิม
// ---------------------------------------------------------------------
function mkNote(p: Partial<CreditDebitNote> & { id: string }): CreditDebitNote {
  return {
    id: p.id,
    tenantId: "t",
    entryId: p.id,
    customerId: "c1",
    docType: p.docType ?? "credit_note",
    docDate: p.docDate ?? "2026-07-20",
    docNo: p.docNo ?? null,
    reason: p.reason ?? "สินค้าชำรุด",
    status: p.status ?? "confirmed",
    createdAt: "2026-07-20T00:00:00Z",
    confirmedAt: "2026-07-20T00:00:00Z",
    lines: p.lines ?? [{ lineNo: 1, description: null, accountCode: "4010", accountName: "ขายสินค้า", amount: 500, vatAmount: 35 }],
  };
}

describe("journal-books: buildJournalBooks + notePostings (เฟส 3 ส่วน J, 0.7 — CN/DN เข้าเล่ม sale/purchase ไม่ใช่ receipt/payment)", () => {
  it("CN ของบิลขาย → โผล่ในเล่ม \"สมุดรายวันขาย\" (ไม่ใช่เล่มรับเงิน)", () => {
    const note = toNoteJournalPosting(mkNote({ id: "cn1" }), { entryType: "sale", docNo: "INV-1", customerId: "c1", counterpartyName: "ลูกค้า A" }, {});
    const { books } = buildJournalBooks([], {}, [note]);
    expect(books.sale.postings).toHaveLength(1);
    expect(books.receipt.postings).toHaveLength(0);
    expect(books.sale.totalDebit).toBe(books.sale.totalCredit);
  });

  it("DN ของบิลซื้อ → โผล่ในเล่ม \"สมุดรายวันซื้อ\" (ไม่ใช่เล่มจ่ายเงิน)", () => {
    const note = toNoteJournalPosting(
      mkNote({ id: "dn1", docType: "debit_note", lines: [{ lineNo: 1, description: null, accountCode: "5010", accountName: "ซื้อสินค้า", amount: 500, vatAmount: 35 }] }),
      { entryType: "purchase", docNo: "PO-1", customerId: "c1", counterpartyName: "ผู้ขาย B" },
      {}
    );
    const { books } = buildJournalBooks([], {}, [note]);
    expect(books.purchase.postings).toHaveLength(1);
    expect(books.payment.postings).toHaveLength(0);
    expect(books.purchase.totalDebit).toBe(books.purchase.totalCredit);
  });

  it("ผสมบิลจริง + manual JE + CN ในเล่มเดียวกัน (ขาย) → ยอดรวมทุกเล่มยังสมดุล", () => {
    const entries = [
      mkEntry({
        id: "s1",
        entryType: "sale",
        paymentMethod: "credit",
        lines: [mkLine({ accountCode: "4010", amount: 2000, vatAmount: 140 })],
      }),
    ];
    const manualJv = toJournalPosting(mkManualEntry({ id: "jv1", docType: "JV" }));
    const cn = toNoteJournalPosting(mkNote({ id: "cn1" }), { entryType: "sale", docNo: "INV-1", customerId: "c1", counterpartyName: "ลูกค้า A" }, {});
    const { books } = buildJournalBooks(entries, {}, [manualJv, cn]);
    for (const k of BOOK_ORDER) {
      expect(books[k].totalDebit).toBe(books[k].totalCredit);
    }
    // เล่มขายมีทั้งบิลจริงและ CN (2 posting)
    expect(books.sale.postings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------
describe("journal-books: zipPosting (จับคู่เดบิต/เครดิตเป็นแถว)", () => {
  it("จำนวนแถว = max(เดบิต, เครดิต) · ฝั่งหมดก่อนเป็น null", () => {
    const p: JournalPosting = {
      entryId: "e", date: null, docNo: null, description: "",
      debits: [
        { accountCode: "5010", accountName: "ซื้อ", amount: 1000 },
        { accountCode: "1154", accountName: "ภาษีซื้อ", amount: 70 },
      ],
      credits: [{ accountCode: "2010", accountName: "เจ้าหนี้", amount: 1070 }],
      totalDebit: 1070, totalCredit: 1070, book: "purchase",
    };
    const rows = zipPosting(p);
    expect(rows).toHaveLength(2);
    expect(rows[0].debit?.accountCode).toBe("5010");
    expect(rows[0].credit?.accountCode).toBe("2010");
    expect(rows[1].debit?.accountCode).toBe("1154");
    expect(rows[1].credit).toBeNull();
  });
});

// ---------------------------------------------------------------------
describe("journal-books: visibleBooks (เลือกเล่มที่แสดง/พิมพ์)", () => {
  it("'all' → ครบ 5 เล่มตามลำดับ", () => {
    expect(visibleBooks("all")).toEqual(BOOK_ORDER);
  });
  it("ค่าไม่รู้จัก → ครบ 5 เล่ม (กัน param เพี้ยน)", () => {
    expect(visibleBooks("")).toEqual(BOOK_ORDER);
    expect(visibleBooks("weird")).toEqual(BOOK_ORDER);
  });
  it("ระบุเล่มเดียว → เล่มนั้นเล่มเดียว", () => {
    expect(visibleBooks("sale")).toEqual(["sale"]);
    expect(visibleBooks("purchase")).toEqual(["purchase"]);
    expect(visibleBooks("general")).toEqual(["general"]);
  });
});
