import { describe, it, expect } from "vitest";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import { defaultFlowAccountSync } from "@/lib/accounting/queries";
import {
  splitEntryVat,
  toVatReportRow,
  buildVatReport,
} from "@/lib/accounting/vat-report";

// ---------- helpers (mirror rd-export.test) ----------
function mkLine(p: Partial<BillEntryLine>): BillEntryLine {
  return {
    id: "l", entryId: "e", lineNo: 1, vatType: "vat", description: null,
    accountCode: null, accountName: null, amount: 0, vatAmount: 0, whtRate: 0,
    whtAmount: 0, aiFilled: false, aiLowConfidence: false, ...p,
  };
}
function mkEntry(p: Partial<BillEntry> & { id: string }): BillEntry {
  return {
    id: p.id, tenantId: "t", attachmentId: null, customerId: "c1", customerName: null,
    attachmentObjectPath: null, uploadPath: null, uploadName: null, uploadMime: null,
    entryType: p.entryType ?? "purchase", docDate: p.docDate ?? "2026-07-05", docNo: p.docNo ?? "PV-1",
    counterpartyName: p.counterpartyName ?? null, counterpartyTaxId: p.counterpartyTaxId ?? null,
    sellerName: p.sellerName ?? null, sellerTaxId: p.sellerTaxId ?? null,
    buyerName: p.buyerName ?? null, buyerTaxId: p.buyerTaxId ?? null,
    whtForm: null, paymentMethod: "cash",
    paymentBankAccountId: null, paymentBankAccountCode: null,
    dueDate: p.dueDate ?? null,
    status: p.status ?? "confirmed", source: "ai", aiConfidence: null, notes: null,
    createdAt: "2026-07-01T00:00:00Z", confirmedAt: null,
    inputTaxMonth: null, flowaccountSync: defaultFlowAccountSync(),
    lines: p.lines ?? [],
  };
}

describe("vat-report: splitEntryVat แยกคิด/ยกเว้น/VAT ต่อบิล", () => {
  it("บิลผสม line คิด VAT + ยกเว้น VAT", () => {
    const e = mkEntry({
      id: "a",
      lines: [
        mkLine({ vatType: "vat", amount: 1000, vatAmount: 70 }),
        mkLine({ vatType: "vat", amount: 500, vatAmount: 35 }),
        mkLine({ vatType: "novat", amount: 200, vatAmount: 0 }),
      ],
    });
    const s = splitEntryVat(e);
    expect(s.baseVat).toBe(1500);
    expect(s.baseExempt).toBe(200);
    expect(s.vat).toBe(105);
  });

  it("บิลยกเว้น VAT ล้วน → baseVat=0, vat=0, baseExempt=ยอด", () => {
    const e = mkEntry({
      id: "b",
      lines: [mkLine({ vatType: "novat", amount: 900, vatAmount: 0 })],
    });
    const s = splitEntryVat(e);
    expect(s.baseVat).toBe(0);
    expect(s.baseExempt).toBe(900);
    expect(s.vat).toBe(0);
  });

  it("ปัดทศนิยม 2 ตำแหน่ง (กัน float สะสม)", () => {
    const e = mkEntry({
      id: "c",
      lines: [
        mkLine({ vatType: "vat", amount: 0.1, vatAmount: 0.007 }),
        mkLine({ vatType: "vat", amount: 0.2, vatAmount: 0.014 }),
      ],
    });
    const s = splitEntryVat(e);
    expect(s.baseVat).toBe(0.3);
    expect(s.vat).toBe(0.02);
  });
});

describe("vat-report: toVatReportRow เลือกชื่อ/เลขภาษีตามฝั่ง", () => {
  it("ภาษีซื้อ = ผู้ขาย (seller) + สำนักงานใหญ่", () => {
    const e = mkEntry({
      id: "a", entryType: "purchase",
      sellerName: "ร้านขายของ", sellerTaxId: "0-1055-65114-21-6",
      buyerName: "ลูกค้าเรา", buyerTaxId: "1111111111119",
    });
    const r = toVatReportRow(e, "purchase");
    expect(r.partyName).toBe("ร้านขายของ");
    expect(r.partyTaxId).toBe("0105565114216"); // normalize ตัดตัวคั่น
    expect(r.isHeadOffice).toBe(true);
  });

  it("ภาษีขาย = ผู้ซื้อ (buyer) · fallback → counterparty", () => {
    const e = mkEntry({
      id: "b", entryType: "sale",
      buyerName: null, buyerTaxId: null,
      counterpartyName: "ผู้ซื้อสำรอง", counterpartyTaxId: "3101500889247",
    });
    const r = toVatReportRow(e, "sale");
    expect(r.partyName).toBe("ผู้ซื้อสำรอง");
    expect(r.partyTaxId).toBe("3101500889247");
  });

  it("ไม่มีเลขภาษี → null", () => {
    const e = mkEntry({ id: "c", sellerTaxId: null, counterpartyTaxId: null });
    expect(toVatReportRow(e, "purchase").partyTaxId).toBeNull();
  });
});

describe("vat-report: buildVatReport คัดประเภท + เรียงวันที่ + รวมยอด", () => {
  const entries = [
    mkEntry({ id: "p2", entryType: "purchase", docDate: "2026-07-10", docNo: "B", lines: [mkLine({ amount: 100, vatAmount: 7 })] }),
    mkEntry({ id: "p1", entryType: "purchase", docDate: "2026-07-03", docNo: "A", lines: [mkLine({ amount: 200, vatAmount: 14 })] }),
    // ยกเว้น VAT ล้วน — ต้องเข้ารายงาน (แสดงคอลัมน์ยกเว้น)
    mkEntry({ id: "p3", entryType: "purchase", docDate: "2026-07-20", docNo: "C", lines: [mkLine({ vatType: "novat", amount: 50 })] }),
    // ขาย — ต้องไม่เข้ารายงานภาษีซื้อ
    mkEntry({ id: "s1", entryType: "sale", lines: [mkLine({ amount: 999, vatAmount: 69.93 })] }),
    // รอระบุ — ไม่เข้ารายงานฝั่งใด
    mkEntry({ id: "u1", entryType: "unspecified", lines: [mkLine({ amount: 1, vatAmount: 0 })] }),
  ];

  it("purchase: คัดเฉพาะซื้อ + เรียงเก่า→ใหม่", () => {
    const rep = buildVatReport(entries, "purchase");
    expect(rep.rows.map((r) => r.entryId)).toEqual(["p1", "p2", "p3"]);
    expect(rep.totals.count).toBe(3);
    expect(rep.totals.baseVatTotal).toBe(300); // 100 + 200 (p3 เป็น novat)
    expect(rep.totals.baseExemptTotal).toBe(50);
    expect(rep.totals.vatTotal).toBe(21);
  });

  it("sale: ได้เฉพาะบิลขาย", () => {
    const rep = buildVatReport(entries, "sale");
    expect(rep.rows.map((r) => r.entryId)).toEqual(["s1"]);
    expect(rep.totals.vatTotal).toBe(69.93);
  });

  it("ไม่มีบิลของประเภทนั้น → รายงานว่าง (ยอดรวม 0)", () => {
    const rep = buildVatReport([entries[3]], "purchase");
    expect(rep.rows).toHaveLength(0);
    expect(rep.totals).toEqual({ count: 0, baseVatTotal: 0, baseExemptTotal: 0, vatTotal: 0 });
  });
});
