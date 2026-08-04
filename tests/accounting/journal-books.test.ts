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
    status: "confirmed", source: "ai", aiConfidence: null, notes: null,
    createdAt: "2026-07-01T00:00:00Z", confirmedAt: null, lines: p.lines ?? [],
  };
}

// ---------------------------------------------------------------------
describe("journal-books: classifyBook (จัดเล่มตามชนิดเอกสาร)", () => {
  it("บิลซื้อทุกวิธีชำระ → เล่มซื้อ", () => {
    for (const m of ["credit", "cheque", "cash", "transfer", null] as (PaymentMethod | null)[]) {
      expect(classifyBook("purchase", m)).toBe("purchase");
    }
  });
  it("บิลขายทุกวิธีชำระ → เล่มขาย", () => {
    for (const m of ["credit", "cheque", "cash", "transfer", null] as (PaymentMethod | null)[]) {
      expect(classifyBook("sale", m)).toBe("sale");
    }
  });

  // ★ #10: บิลขายห้ามตกเล่ม "ทั่วไป" — ทุกวิธีจ่าย (รวม null) ต้องไม่ใช่ general
  it("#10 ขายไม่วิ่งสมุดรายวันทั่วไป (ทุกวิธีจ่าย)", () => {
    const methods: (PaymentMethod | null)[] = ["cash", "cheque", "transfer", "credit", null];
    for (const m of methods) {
      expect(classifyBook("sale", m)).not.toBe("general");
    }
  });

  it("unspecified → ทั่วไป", () => {
    expect(classifyBook("unspecified", "cash")).toBe("general");
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

  it("ซื้อเงินสดเข้าเล่มซื้อ (ตามชนิดเอกสาร) · เล่มจ่ายว่าง", () => {
    const entries = [
      mkEntry({
        id: "p2", entryType: "purchase", paymentMethod: "cash",
        lines: [mkLine({ accountCode: "5340", accountName: "ค่าน้ำมัน", amount: 500, vatAmount: 35 })],
      }),
    ];
    const { books } = buildJournalBooks(entries);
    expect(books.purchase.postings).toHaveLength(1);
    expect(books.payment.postings).toHaveLength(0);
  });

  it("ขายทุกใบเข้าเล่มขาย (เงินสด/เชื่อ) · เล่มรับ/ทั่วไปว่าง", () => {
    const entries = [
      mkEntry({ id: "s1", entryType: "sale", paymentMethod: "credit",
        lines: [mkLine({ accountCode: "4010", accountName: "ขายสินค้า", amount: 1000, vatAmount: 70 })] }),
      mkEntry({ id: "s2", entryType: "sale", paymentMethod: "cash",
        lines: [mkLine({ accountCode: "4010", accountName: "ขายสินค้า", amount: 2000, vatAmount: 140 })] }),
    ];
    const { books } = buildJournalBooks(entries);
    expect(books.sale.postings).toHaveLength(2);
    expect(books.receipt.postings).toHaveLength(0);
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
