import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildBillEntriesWorkbook } from "@/lib/accounting/excel";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";

/**
 * accounting/excel — สร้างไฟล์ .xlsx จริง 2 ชีท (ภาษีซื้อ/ภาษีขาย)
 *   ตรวจ: มี 2 ชีท, หัวคอลัมน์, แถว line, แถวรวมท้าย, แยกประเภทถูก
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
    customerId: null,
    customerName: null,
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
    status: "draft",
    source: "ai",
    aiConfidence: null,
    notes: null,
    createdAt: "2026-07-01T00:00:00Z",
    confirmedAt: null,
    inputTaxMonth: null,
    lines: p.lines ?? [],
  };
}

describe("buildBillEntriesWorkbook", () => {
  it("คืน Buffer ที่เป็นไฟล์ xlsx อ่านกลับได้ + มี 2 ชีท", async () => {
    const buf = await buildBillEntriesWorkbook([
      entry({
        entryType: "purchase",
        docNo: "INV-1",
        counterpartyName: "ผู้ขาย ก",
        whtForm: "pnd53",
        lines: [line({ amount: 100, vatAmount: 7, whtRate: 3, whtAmount: 3 })],
      }),
      entry({
        entryType: "sale",
        docNo: "S-1",
        counterpartyName: "ลูกค้า ข",
        lines: [line({ amount: 1000, vatAmount: 70 })],
      }),
    ]);

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(["ภาษีซื้อ", "ภาษีขาย"]);
  });

  it("ชีทภาษีซื้อมีหัวคอลัมน์ + แถว line + แถวรวมท้าย", async () => {
    const buf = await buildBillEntriesWorkbook([
      entry({
        entryType: "purchase",
        docDate: "2026-07-10",
        docNo: "INV-9",
        lines: [
          line({ amount: 100, vatAmount: 7, description: "ของ A", accountCode: "5010", accountName: "ซื้อสินค้า" }),
          line({ amount: 50, vatAmount: 0, vatType: "novat", description: "ของ B" }),
        ],
      }),
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.getWorksheet("ภาษีซื้อ")!;

    // หัวคอลัมน์ (คอลัมน์: วันที่1 เลขที่2 คู่ค้า3 เลขภาษี4 รายการ5 รหัสบัญชี6 ชื่อบัญชี7 ประเภทVAT8 มูลค่า9 VAT10 ...)
    expect(ws.getRow(1).getCell(1).value).toBe("วันที่");
    expect(ws.getRow(1).getCell(6).value).toBe("รหัสบัญชี");
    expect(ws.getRow(1).getCell(7).value).toBe("ชื่อบัญชี");
    expect(ws.getRow(1).getCell(9).value).toBe("มูลค่า");

    // 2 line + 1 แถวรวม = 3 แถวข้อมูล (row 2,3,4)
    expect(ws.getRow(2).getCell(6).value).toBe("5010");
    expect(ws.getRow(2).getCell(7).value).toBe("ซื้อสินค้า");
    expect(ws.getRow(2).getCell(9).value).toBe(100);
    expect(ws.getRow(3).getCell(9).value).toBe(50);
    // แถวรวมท้าย: มูลค่า 150, VAT 7 (รวมทั้งสิ้น อยู่คอลัมน์ "รายการ" = 5)
    const totalRow = ws.getRow(4);
    expect(totalRow.getCell(5).value).toBe("รวมทั้งสิ้น");
    expect(totalRow.getCell(9).value).toBe(150);
    expect(totalRow.getCell(10).value).toBe(7);
  });

  it("ไม่มี entry เลย → ยังได้ 2 ชีท + แถวรวม 0", async () => {
    const buf = await buildBillEntriesWorkbook([]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets.length).toBe(2);
    const ws = wb.getWorksheet("ภาษีขาย")!;
    // มีแค่หัว (row1) + แถวรวม (row2) — มูลค่าอยู่คอลัมน์ 9
    expect(ws.getRow(2).getCell(9).value).toBe(0);
  });
});
