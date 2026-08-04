import { describe, it, expect } from "vitest";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import {
  calcSbt,
  defaultSbtBase,
  SBT_RATE,
  LOCAL_TAX_RATE,
} from "@/lib/accounting/sbt-report";

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
    entryType: p.entryType ?? "sale", docDate: p.docDate ?? "2026-07-05", docNo: p.docNo ?? "IV-1",
    counterpartyName: null, counterpartyTaxId: null,
    sellerName: null, sellerTaxId: null, buyerName: null, buyerTaxId: null,
    whtForm: null, paymentMethod: "cash",
    paymentBankAccountId: null, paymentBankAccountCode: null,
    status: "confirmed", source: "ai", aiConfidence: null, notes: null,
    createdAt: "2026-07-01T00:00:00Z", confirmedAt: null, lines: p.lines ?? [],
  };
}

describe("sbt-report: calcSbt (ฐาน × 3.3%)", () => {
  it("อัตราคงที่ = SBT 3% + ท้องถิ่น 10% ของ SBT", () => {
    expect(SBT_RATE).toBe(0.03);
    expect(LOCAL_TAX_RATE).toBe(0.1);
  });

  it("ฐาน 100,000 → SBT 3,000 + ท้องถิ่น 300 = รวม 3,300", () => {
    const r = calcSbt(100000);
    expect(r.base).toBe(100000);
    expect(r.sbt).toBe(3000);
    expect(r.localTax).toBe(300);
    expect(r.total).toBe(3300);
  });

  it("รวม = ฐาน × 3.3% เสมอ (เศษปัด 2)", () => {
    const r = calcSbt(12345.67);
    expect(r.sbt).toBe(370.37); // 12345.67*0.03=370.3701
    expect(r.localTax).toBe(37.04); // 370.37*0.1=37.037
    expect(r.total).toBe(407.41); // 370.37+37.04
  });

  it("ฐาน 0 → ทุกช่อง 0", () => {
    expect(calcSbt(0)).toEqual({ base: 0, sbt: 0, localTax: 0, total: 0 });
  });

  it("ฐานติดลบ/NaN → clamp เป็น 0 (กันกรอกมั่ว)", () => {
    expect(calcSbt(-500)).toEqual({ base: 0, sbt: 0, localTax: 0, total: 0 });
    expect(calcSbt(NaN as unknown as number)).toEqual({ base: 0, sbt: 0, localTax: 0, total: 0 });
  });
});

describe("sbt-report: defaultSbtBase (ค่าเริ่มต้น = รายได้ฝั่งขายก่อน VAT)", () => {
  it("รวมเฉพาะบิลขาย ก่อน VAT (ไม่รวม VAT/ไม่รวมซื้อ)", () => {
    const entries = [
      mkEntry({ id: "s1", entryType: "sale", lines: [mkLine({ amount: 1000, vatAmount: 70 })] }),
      mkEntry({ id: "s2", entryType: "sale", lines: [mkLine({ amount: 2000, vatAmount: 140 })] }),
      mkEntry({ id: "p1", entryType: "purchase", lines: [mkLine({ amount: 9999, vatAmount: 700 })] }),
    ];
    expect(defaultSbtBase(entries)).toBe(3000); // 1000+2000 (ไม่รวม VAT/ซื้อ)
  });

  it("ไม่มีบิลขาย → 0", () => {
    const entries = [
      mkEntry({ id: "p1", entryType: "purchase", lines: [mkLine({ amount: 500 })] }),
    ];
    expect(defaultSbtBase(entries)).toBe(0);
  });
});
