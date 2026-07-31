import { describe, it, expect } from "vitest";
import {
  lineNet,
  round2,
  summarizeEntry,
  summarizeEntries,
  monthRange,
  type BillEntry,
  type BillEntryLine,
} from "@/lib/accounting/queries";

/**
 * accounting/queries — คำนวณสรุป (pure) + monthRange
 */

function line(p: Partial<BillEntryLine>): BillEntryLine {
  return {
    id: p.id ?? "l1",
    entryId: p.entryId ?? "e1",
    lineNo: p.lineNo ?? 1,
    vatType: p.vatType ?? "vat",
    description: p.description ?? null,
    amount: p.amount ?? 0,
    vatAmount: p.vatAmount ?? 0,
    whtRate: p.whtRate ?? 0,
    whtAmount: p.whtAmount ?? 0,
    aiFilled: p.aiFilled ?? false,
  };
}

function entry(p: Partial<BillEntry>): BillEntry {
  return {
    id: p.id ?? "e1",
    tenantId: p.tenantId ?? "t1",
    attachmentId: p.attachmentId ?? null,
    customerId: p.customerId ?? null,
    customerName: p.customerName ?? null,
    attachmentObjectPath: p.attachmentObjectPath ?? null,
    uploadPath: p.uploadPath ?? null,
    uploadName: p.uploadName ?? null,
    uploadMime: p.uploadMime ?? null,
    entryType: p.entryType ?? "purchase",
    docDate: p.docDate ?? null,
    docNo: p.docNo ?? null,
    counterpartyName: p.counterpartyName ?? null,
    counterpartyTaxId: p.counterpartyTaxId ?? null,
    sellerName: p.sellerName ?? null,
    sellerTaxId: p.sellerTaxId ?? null,
    buyerName: p.buyerName ?? null,
    buyerTaxId: p.buyerTaxId ?? null,
    whtForm: p.whtForm ?? null,
    status: p.status ?? "draft",
    source: p.source ?? "ai",
    aiConfidence: p.aiConfidence ?? null,
    notes: p.notes ?? null,
    createdAt: p.createdAt ?? "2026-07-01T00:00:00Z",
    confirmedAt: p.confirmedAt ?? null,
    lines: p.lines ?? [],
  };
}

describe("lineNet — มูลค่า + VAT - หัก ณ ที่จ่าย", () => {
  it("คำนวณถูกต้อง", () => {
    expect(lineNet({ amount: 100, vatAmount: 7, whtAmount: 3 })).toBe(104);
  });
  it("ปัดทศนิยม 2 ตำแหน่ง", () => {
    expect(lineNet({ amount: 100.005, vatAmount: 0, whtAmount: 0 })).toBe(100.01);
  });
});

describe("round2", () => {
  it("ปัด 2 ตำแหน่ง กัน floating error", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe("summarizeEntry — รวมทุก line ของ entry", () => {
  it("รวม amount/vat/wht/net", () => {
    const s = summarizeEntry([
      line({ amount: 100, vatAmount: 7, whtAmount: 3 }),
      line({ amount: 50, vatAmount: 0, whtAmount: 0, vatType: "novat" }),
    ]);
    expect(s.amount).toBe(150);
    expect(s.vat).toBe(7);
    expect(s.wht).toBe(3);
    expect(s.net).toBe(154); // 150 + 7 - 3
  });
});

describe("summarizeEntries — แยกประเภท purchase/sale", () => {
  it("แยกยอด + นับจำนวนถูก", () => {
    const entries = [
      entry({ entryType: "purchase", lines: [line({ amount: 100, vatAmount: 7 })] }),
      entry({ entryType: "purchase", lines: [line({ amount: 200, vatAmount: 14, whtAmount: 6 })] }),
      entry({ entryType: "sale", lines: [line({ amount: 1000, vatAmount: 70 })] }),
    ];
    const s = summarizeEntries(entries);
    expect(s.purchase.count).toBe(2);
    expect(s.purchase.amount).toBe(300);
    expect(s.purchase.vat).toBe(21);
    expect(s.purchase.wht).toBe(6);
    expect(s.purchase.net).toBe(315); // 300 + 21 - 6
    expect(s.sale.count).toBe(1);
    expect(s.sale.amount).toBe(1000);
    expect(s.sale.net).toBe(1070);
  });

  it("ไม่มี entry → ยอด 0 ทุกช่อง", () => {
    const s = summarizeEntries([]);
    expect(s.purchase.count).toBe(0);
    expect(s.sale.amount).toBe(0);
  });

  it("entry 'unspecified' (รอระบุ) → ไม่ถูกนับในสรุปซื้อ/ขาย", () => {
    const s = summarizeEntries([
      entry({ entryType: "unspecified", lines: [line({ amount: 999, vatAmount: 70 })] }),
      entry({ entryType: "purchase", lines: [line({ amount: 100, vatAmount: 7 })] }),
    ]);
    expect(s.purchase.count).toBe(1);
    expect(s.purchase.amount).toBe(100);
    expect(s.sale.count).toBe(0);
  });
});

describe("monthRange — ช่วงวันของเดือน", () => {
  it("เดือนปกติ", () => {
    expect(monthRange("2026-07")).toEqual({ start: "2026-07-01", end: "2026-08-01" });
  });
  it("เดือน ธ.ค. → ข้ามปี", () => {
    expect(monthRange("2026-12")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
  });
  it("รูปแบบผิด / เดือนเกิน → null", () => {
    expect(monthRange("2026-13")).toBeNull();
    expect(monthRange("bad")).toBeNull();
    expect(monthRange(undefined)).toBeNull();
  });
});
