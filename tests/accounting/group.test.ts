import { describe, it, expect } from "vitest";
import {
  groupEntriesByCustomer,
  summarizeAll,
  entriesOfType,
  countOfType,
} from "@/lib/accounting/group";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";

/**
 * accounting/group — จัดกลุ่มตามลูกค้า + สรุปยอดแยกประเภท (pure)
 */

function line(p: Partial<BillEntryLine>): BillEntryLine {
  return {
    id: p.id ?? "l1",
    entryId: p.entryId ?? "e1",
    lineNo: p.lineNo ?? 1,
    vatType: p.vatType ?? "vat",
    description: p.description ?? null,
    accountCode: p.accountCode ?? null,
    accountName: p.accountName ?? null,
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
    tenantId: "t1",
    attachmentId: null,
    customerId: p.customerId ?? null,
    customerName: p.customerName ?? null,
    attachmentObjectPath: null,
    uploadPath: null,
    uploadName: null,
    uploadMime: null,
    entryType: p.entryType ?? "purchase",
    docDate: p.docDate ?? null,
    docNo: p.docNo ?? null,
    counterpartyName: null,
    counterpartyTaxId: null,
    sellerName: null,
    sellerTaxId: null,
    buyerName: null,
    buyerTaxId: null,
    whtForm: null,
    status: p.status ?? "draft",
    source: p.source ?? "ai",
    aiConfidence: null,
    notes: null,
    createdAt: p.createdAt ?? "2026-07-01T00:00:00Z",
    confirmedAt: null,
    lines: p.lines ?? [],
  };
}

describe("groupEntriesByCustomer — ลูกค้าเป็นกลุ่มหลัก", () => {
  it("เรียงจำนวนมาก→น้อย + ยังไม่จับคู่ท้ายสุด", () => {
    const entries = [
      entry({ id: "a1", customerId: "cA", customerName: "ลูกค้า A", entryType: "purchase", lines: [line({ amount: 100, vatAmount: 7 })] }),
      entry({ id: "b1", customerId: "cB", customerName: "ลูกค้า B", entryType: "sale", lines: [line({ amount: 200, vatAmount: 14 })] }),
      entry({ id: "b2", customerId: "cB", customerName: "ลูกค้า B", entryType: "purchase", lines: [line({ amount: 50, vatAmount: 3.5 })] }),
      entry({ id: "u1", customerId: null, entryType: "unspecified", lines: [line({ amount: 999, vatAmount: 70 })] }),
    ];
    const groups = groupEntriesByCustomer(entries);
    expect(groups.map((g) => g.customerId)).toEqual(["cB", "cA", null]); // B(2) > A(1) > ยังไม่จับคู่
    expect(groups[groups.length - 1].customerId).toBeNull();
  });

  it("สรุปแยกประเภทในลูกค้า + รวมทั้งราย", () => {
    const groups = groupEntriesByCustomer([
      entry({ customerId: "cB", customerName: "B", entryType: "purchase", lines: [line({ amount: 100, vatAmount: 7, whtAmount: 3 })] }),
      entry({ customerId: "cB", customerName: "B", entryType: "sale", lines: [line({ amount: 1000, vatAmount: 70 })] }),
    ]);
    const g = groups[0];
    expect(g.purchaseCount).toBe(1);
    expect(g.saleCount).toBe(1);
    expect(g.summary.purchase.net).toBe(104); // 100 + 7 - 3
    expect(g.summary.sale.net).toBe(1070);
    expect(g.summary.all.amount).toBe(1100);
    expect(g.summary.all.net).toBe(1174); // 104 + 1070
  });

  it("นับ unspecified ไว้เน้น amber", () => {
    const groups = groupEntriesByCustomer([
      entry({ customerId: "cC", customerName: "C", entryType: "unspecified", lines: [line({ amount: 10 })] }),
      entry({ customerId: "cC", customerName: "C", entryType: "purchase", lines: [line({ amount: 10, vatAmount: 0.7 })] }),
    ]);
    expect(groups[0].unspecifiedCount).toBe(1);
    expect(groups[0].count).toBe(2);
  });
});

describe("summarizeAll — KPI รวมทุกประเภท", () => {
  it("รวม amount/vat/wht/net ข้ามประเภท (รวม unspecified)", () => {
    const s = summarizeAll([
      entry({ entryType: "purchase", lines: [line({ amount: 100, vatAmount: 7, whtAmount: 3 })] }),
      entry({ entryType: "unspecified", lines: [line({ amount: 50, vatAmount: 3.5 })] }),
    ]);
    expect(s.amount).toBe(150);
    expect(s.vat).toBe(10.5);
    expect(s.wht).toBe(3);
    expect(s.net).toBe(157.5); // 150 + 10.5 - 3
  });
});

describe("entriesOfType / countOfType", () => {
  it("กรอง entry ตามประเภทในกลุ่ม", () => {
    const groups = groupEntriesByCustomer([
      entry({ id: "p1", customerId: "c", customerName: "c", entryType: "purchase", lines: [line({ amount: 1 })] }),
      entry({ id: "s1", customerId: "c", customerName: "c", entryType: "sale", lines: [line({ amount: 1 })] }),
    ]);
    const g = groups[0];
    expect(entriesOfType(g, "purchase").map((e) => e.id)).toEqual(["p1"]);
    expect(countOfType(g, "sale")).toBe(1);
    expect(countOfType(g, "unspecified")).toBe(0);
  });
});
