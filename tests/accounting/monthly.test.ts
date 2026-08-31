import { describe, it, expect } from "vitest";
import {
  monthKeyOf,
  buildMonthlyIndex,
  summarizeMonth,
  customerColumnRows,
  thaiMonthLabel,
} from "@/lib/accounting/monthly";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";

/**
 * accounting/monthly — ตัดงานรายเดือน (จัดกลุ่มเดือน + undated, KPI เดือน, คอลัมน์ซื้อ/ขายรายลูกค้า)
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
    docNo: null,
    counterpartyName: null,
    counterpartyTaxId: null,
    sellerName: null,
    sellerTaxId: null,
    buyerName: null,
    buyerTaxId: null,
    whtForm: null,
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
    lines: p.lines ?? [],
  };
}

describe("monthKeyOf", () => {
  it("ดึง YYYY-MM จาก docDate · null เมื่อไม่มีวันที่", () => {
    expect(monthKeyOf({ docDate: "2026-07-15" })).toBe("2026-07");
    expect(monthKeyOf({ docDate: null })).toBeNull();
    expect(monthKeyOf({ docDate: "ไม่ใช่วันที่" })).toBeNull();
  });
});

describe("buildMonthlyIndex — แถบเลือกเดือน + undated", () => {
  it("จัดกลุ่มตามเดือน เรียงใหม่→เก่า + นับ undated", () => {
    const idx = buildMonthlyIndex([
      entry({ id: "a", docDate: "2026-07-05", entryType: "purchase", status: "confirmed" }),
      entry({ id: "b", docDate: "2026-07-20", entryType: "sale", status: "draft" }),
      entry({ id: "c", docDate: "2026-06-10", entryType: "purchase", status: "confirmed" }),
      entry({ id: "d", docDate: null, entryType: "unspecified" }),
      entry({ id: "e", docDate: null, entryType: "purchase" }),
    ]);
    expect(idx.months.map((m) => m.month)).toEqual(["2026-07", "2026-06"]);
    expect(idx.undatedCount).toBe(2);

    const jul = idx.months[0];
    expect(jul.purchaseCount).toBe(1);
    expect(jul.saleCount).toBe(1);
    expect(jul.total).toBe(2);
    // รอตรวจ = b (draft) → 1 · a เป็น confirmed/purchase ไม่นับ
    expect(jul.pendingCount).toBe(1);
  });

  it("นับ pending รวม unspecified แม้ confirmed ไม่ซ้ำ", () => {
    const idx = buildMonthlyIndex([
      entry({ docDate: "2026-05-01", entryType: "unspecified", status: "confirmed" }),
    ]);
    expect(idx.months[0].pendingCount).toBe(1); // unspecified → รอตรวจ
  });
});

describe("summarizeMonth — KPI เดือน", () => {
  it("แยกฐาน/VAT ซื้อ·ขาย + หักรวม + ยืนยันแล้ว", () => {
    const k = summarizeMonth([
      entry({ entryType: "purchase", status: "confirmed", lines: [line({ amount: 1000, vatAmount: 70, whtAmount: 30 })] }),
      entry({ entryType: "purchase", status: "draft", lines: [line({ amount: 500, vatAmount: 35 })] }),
      entry({ entryType: "sale", status: "confirmed", lines: [line({ amount: 2000, vatAmount: 140, whtAmount: 10 })] }),
    ]);
    expect(k.purchaseBase).toBe(1500);
    expect(k.purchaseVat).toBe(105);
    expect(k.saleBase).toBe(2000);
    expect(k.saleVat).toBe(140);
    expect(k.wht).toBe(40); // 30 + 10
    expect(k.confirmedCount).toBe(2);
    expect(k.totalCount).toBe(3);
  });
});

describe("customerColumnRows — รายลูกค้าต่อคอลัมน์", () => {
  it("รวมเฉพาะประเภทที่เลือก เรียงฐานมาก→น้อย + นับร่าง", () => {
    const rows = customerColumnRows(
      [
        entry({ customerId: "cA", customerName: "A", entryType: "purchase", status: "draft", lines: [line({ amount: 100, vatAmount: 7 })] }),
        entry({ customerId: "cB", customerName: "B", entryType: "purchase", status: "confirmed", lines: [line({ amount: 900, vatAmount: 63 })] }),
        entry({ customerId: "cA", customerName: "A", entryType: "sale", lines: [line({ amount: 50 })] }),
      ],
      "purchase"
    );
    expect(rows.map((r) => r.customerId)).toEqual(["cB", "cA"]); // ฐาน 900 > 100
    const a = rows.find((r) => r.customerId === "cA")!;
    expect(a.count).toBe(1);
    expect(a.base).toBe(100);
    expect(a.vat).toBe(7);
    expect(a.draftCount).toBe(1);
  });

  it("ลูกค้ายังไม่จับคู่ (null) อยู่ท้ายสุด", () => {
    const rows = customerColumnRows(
      [
        entry({ customerId: null, entryType: "sale", lines: [line({ amount: 9999 })] }),
        entry({ customerId: "cA", customerName: "A", entryType: "sale", lines: [line({ amount: 10 })] }),
      ],
      "sale"
    );
    expect(rows[rows.length - 1].customerId).toBeNull();
  });
});

describe("thaiMonthLabel", () => {
  it("แปลงเป็นเดือนไทย + พ.ศ.", () => {
    expect(thaiMonthLabel("2026-07")).toBe("ก.ค. 2569");
    expect(thaiMonthLabel("2026-01")).toBe("ม.ค. 2569");
    expect(thaiMonthLabel("2025-12")).toBe("ธ.ค. 2568");
  });
  it("ผิดรูปคืนค่าเดิม", () => {
    expect(thaiMonthLabel("bad")).toBe("bad");
    expect(thaiMonthLabel("2026-13")).toBe("2026-13");
  });
});
