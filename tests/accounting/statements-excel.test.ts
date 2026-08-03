import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildStatements } from "@/lib/accounting/statements";
import { buildStatementsWorkbook } from "@/lib/accounting/statements-excel";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import type { OpeningBalance } from "@/lib/accounting/opening-balance";

/** เทสต์ว่า export .xlsx สร้างไฟล์จริงได้ (ไม่ throw) + มีชีทครบ + อ่านกลับได้ */

function mkLine(p: Partial<BillEntryLine>): BillEntryLine {
  return {
    id: "l", entryId: "e", lineNo: 1, vatType: "vat", description: null,
    accountCode: null, accountName: null, amount: 0, vatAmount: 0, whtRate: 0,
    whtAmount: 0, aiFilled: false, ...p,
  };
}
function mkEntry(p: Partial<BillEntry> & { id: string }): BillEntry {
  return {
    id: p.id, tenantId: "t", attachmentId: null, customerId: "c1", customerName: null,
    attachmentObjectPath: null, uploadPath: null, uploadName: null, uploadMime: null,
    entryType: p.entryType ?? "purchase", docDate: p.docDate ?? "2026-07-05", docNo: p.docNo ?? "PV-1",
    counterpartyName: null, counterpartyTaxId: null, sellerName: null, sellerTaxId: null,
    buyerName: null, buyerTaxId: null, whtForm: null, paymentMethod: p.paymentMethod ?? "cash",
    paymentBankAccountId: null, paymentBankAccountCode: p.paymentBankAccountCode ?? null,
    status: "confirmed", source: "ai", aiConfidence: null, notes: null,
    createdAt: "2026-07-01T00:00:00Z", confirmedAt: null, lines: p.lines ?? [],
  };
}

const entries = [
  mkEntry({ id: "p1", entryType: "purchase", paymentMethod: "cash", lines: [mkLine({ accountCode: "5010", amount: 1000, vatAmount: 70, whtAmount: 30 })] }),
  mkEntry({ id: "s1", entryType: "sale", paymentMethod: "credit", docDate: "2026-07-10", lines: [mkLine({ accountCode: "4010", amount: 2000, vatAmount: 140 })] }),
  mkEntry({ id: "u1", entryType: "unspecified", paymentMethod: "cash" }), // ตกหล่น
];
const opening: OpeningBalance[] = [
  { id: "o1", accountCode: "1010", accountName: "เงินสด", openingBalance: 5000, note: null },
  { id: "o2", accountCode: "3010", accountName: "ทุน", openingBalance: -5000, note: null },
];

describe("statements-excel — สร้างไฟล์จริง", () => {
  it("export ทั้งหมด → ได้ Buffer + มีชีทครบ 5 งบ + ชีทตกหล่น", async () => {
    const s = buildStatements(entries, opening);
    const buf = await buildStatementsWorkbook(s, { entityLabel: "N001 · ทดสอบ", periodLabel: "ก.ค. 2569" }, "all");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);

    // อ่านกลับด้วย exceljs ตรวจชื่อชีท
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("สมุดรายวัน");
    expect(names).toContain("บัญชีแยกประเภท");
    expect(names).toContain("งบทดลอง");
    expect(names).toContain("งบกำไรขาดทุน");
    expect(names).toContain("งบแสดงฐานะการเงิน");
    expect(names).toContain("รายการตกหล่น"); // มี u1 ตกหล่น
  });

  it("export งบเดียว (income) → มีชีทเดียว", async () => {
    const s = buildStatements(entries, opening);
    const buf = await buildStatementsWorkbook(s, { entityLabel: "x", periodLabel: "y" }, "income");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["งบกำไรขาดทุน"]);
  });
});
