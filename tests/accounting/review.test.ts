import { describe, it, expect } from "vitest";
import { buildReview } from "@/lib/accounting/review";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import { defaultFlowAccountSync } from "@/lib/accounting/queries";

/**
 * accounting/review — ข้อมูลตรวจทานก่อนออก Excel (pure)
 *   ★ ต้องตรงกับ excel.ts (แถว = แต่ละ line, ซื้อก่อนขาย) + นับ รอระบุ/ร่าง แม่น
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
    aiLowConfidence: p.aiLowConfidence ?? false,
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
    counterpartyName: p.counterpartyName ?? null,
    counterpartyTaxId: p.counterpartyTaxId ?? null,
    sellerName: null,
    sellerTaxId: null,
    buyerName: null,
    buyerTaxId: null,
    whtForm: p.whtForm ?? null,
    paymentMethod: null,
    paymentBankAccountId: null,
    paymentBankAccountCode: null,
    dueDate: p.dueDate ?? null,
    status: p.status ?? "draft",
    source: p.source ?? "ai",
    aiConfidence: null,
    notes: null,
    createdAt: p.createdAt ?? "2026-07-01T00:00:00Z",
    confirmedAt: null,
    inputTaxMonth: null,
    flowaccountSync: defaultFlowAccountSync(),
    lines: p.lines ?? [],
  };
}

describe("buildReview — แถวรวมแยกซื้อ/ขาย", () => {
  it("รวมมูลค่า/VAT/หัก/รวมจ่ายจริง แยกประเภท + นับบิล", () => {
    const r = buildReview([
      entry({ id: "p1", entryType: "purchase", status: "confirmed", lines: [line({ amount: 100, vatAmount: 7, whtAmount: 3 })] }),
      entry({ id: "s1", entryType: "sale", status: "confirmed", lines: [line({ amount: 1000, vatAmount: 70 })] }),
    ]);
    expect(r.purchase.count).toBe(1);
    expect(r.purchase.amount).toBe(100);
    expect(r.purchase.vat).toBe(7);
    expect(r.purchase.wht).toBe(3);
    expect(r.purchase.net).toBe(104); // 100 + 7 - 3
    expect(r.sale.count).toBe(1);
    expect(r.sale.net).toBe(1070);
  });

  it("บิลผสม (หลาย line) แตกหลายแถว — เรียงซื้อก่อนขาย", () => {
    const r = buildReview([
      entry({ id: "s1", entryType: "sale", lines: [line({ amount: 500, vatAmount: 35 })] }),
      entry({
        id: "p1",
        entryType: "purchase",
        lines: [
          line({ id: "a", amount: 100, vatAmount: 7 }),
          line({ id: "b", amount: 50, vatAmount: 0, vatType: "novat" }),
        ],
      }),
    ]);
    // ซื้อ 2 แถว (บิลผสม) มาก่อน แล้วขาย 1 แถว
    expect(r.rows.map((x) => x.type)).toEqual(["purchase", "purchase", "sale"]);
    expect(r.purchase.count).toBe(1); // 1 บิล (แม้ 2 line)
    expect(r.purchase.amount).toBe(150);
    expect(r.rows).toHaveLength(3);
  });

  it("entry ไม่มี line → 1 แถวเปล่า (ตรงกับ excel)", () => {
    const r = buildReview([entry({ id: "p1", entryType: "purchase", lines: [] })]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].vatType).toBeNull();
    expect(r.rows[0].amount).toBe(0);
    expect(r.purchase.count).toBe(1);
  });
});

describe("buildReview — เตือน รอระบุ/ร่าง", () => {
  it("นับ unspecified (ไม่เข้าไฟล์) แยกจาก draft (เข้าไฟล์แต่ยังร่าง)", () => {
    const r = buildReview([
      entry({ id: "u1", entryType: "unspecified", lines: [line({ amount: 10 })] }),
      entry({ id: "u2", entryType: "unspecified", lines: [line({ amount: 20 })] }),
      entry({ id: "p1", entryType: "purchase", status: "draft", lines: [line({ amount: 100, vatAmount: 7 })] }),
      entry({ id: "s1", entryType: "sale", status: "confirmed", lines: [line({ amount: 200, vatAmount: 14 })] }),
    ]);
    expect(r.unspecifiedCount).toBe(2); // ไม่เข้าไฟล์
    expect(r.draftCount).toBe(1); // p1 (ร่าง) — s1 ยืนยันแล้ว ไม่นับ
    // unspecified ไม่เข้าแถว/ยอดซื้อขาย
    expect(r.purchase.count).toBe(1);
    expect(r.sale.count).toBe(1);
    expect(r.rows.every((x) => x.type === "purchase" || x.type === "sale")).toBe(true);
  });

  it("ยืนยันหมด ไม่มีรอระบุ → ไม่มีเตือน", () => {
    const r = buildReview([
      entry({ id: "p1", entryType: "purchase", status: "confirmed", lines: [line({ amount: 100 })] }),
    ]);
    expect(r.unspecifiedCount).toBe(0);
    expect(r.draftCount).toBe(0);
  });
});
