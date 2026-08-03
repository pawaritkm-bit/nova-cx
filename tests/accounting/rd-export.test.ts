import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import type { BillEntry, BillEntryLine } from "@/lib/accounting/queries";
import {
  toThaiDate,
  buildPndReport,
  buildPndTextLines,
  buildPndWorkbook,
  groupWhtByPayee,
  PND_FIELDS,
  buildPp30Report,
  buildPp30TextLines,
  buildPp30Workbook,
  pp30Fields,
  encodeRdText,
  joinRdLines,
  resolveTxtEncoding,
  RD_FIELD_SEP,
  toWhtRecord,
} from "@/lib/accounting/rd-export";

// ---------- helpers ----------
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
    counterpartyName: p.counterpartyName ?? null, counterpartyTaxId: p.counterpartyTaxId ?? null,
    sellerName: p.sellerName ?? null, sellerTaxId: p.sellerTaxId ?? null,
    buyerName: p.buyerName ?? null, buyerTaxId: p.buyerTaxId ?? null,
    whtForm: p.whtForm ?? null, paymentMethod: "cash",
    paymentBankAccountId: null, paymentBankAccountCode: null,
    status: p.status ?? "confirmed", source: "ai", aiConfidence: null, notes: null,
    createdAt: "2026-07-01T00:00:00Z", confirmedAt: null, lines: p.lines ?? [],
  };
}

describe("rd-export: วันที่ พ.ศ.", () => {
  it("แปลง ISO → dd/mm/yyyy พ.ศ. (ค.ศ.+543)", () => {
    expect(toThaiDate("2026-01-04")).toBe("04/01/2569");
    expect(toThaiDate("2026-12-31")).toBe("31/12/2569");
  });
  it("null/รูปแบบผิด → ''", () => {
    expect(toThaiDate(null)).toBe("");
    expect(toThaiDate("not-a-date")).toBe("");
  });
});

describe("rd-export: ภ.ง.ด.3/53 — แยกแบบด้วย wht_form", () => {
  const entries = [
    // pnd3 (บุคคล) มีเลขภาษี + wht
    mkEntry({
      id: "a", whtForm: "pnd3", counterpartyName: "นายเอ", counterpartyTaxId: "3101500889247",
      docDate: "2026-01-04",
      lines: [mkLine({ accountCode: "5342", accountName: "ค่าบริการ", amount: 25000, whtRate: 3, whtAmount: 750 })],
    }),
    // pnd53 (นิติ)
    mkEntry({
      id: "b", whtForm: "pnd53", counterpartyName: "บริษัท บี จำกัด", counterpartyTaxId: "0105565114216",
      docDate: "2026-01-03",
      lines: [mkLine({ accountName: "ค่าบริการแสดงสินค้า", amount: 30000, whtRate: 3, whtAmount: 900 })],
    }),
    // มี wht แต่ wht_form=null → รอระบุแบบ
    mkEntry({
      id: "c", whtForm: null, counterpartyName: "นายซี", counterpartyTaxId: "1111111111119",
      lines: [mkLine({ accountName: "ค่าขนส่ง", amount: 10000, whtRate: 1, whtAmount: 100 })],
    }),
    // pnd3 แต่ไม่มีเลขภาษี → ยื่นไม่ได้
    mkEntry({
      id: "d", whtForm: "pnd3", counterpartyName: "นายดี", counterpartyTaxId: null,
      lines: [mkLine({ accountName: "ค่าบริการ", amount: 5000, whtRate: 3, whtAmount: 150 })],
    }),
    // ไม่มี wht เลย → ไม่ใช่ record ยื่น
    mkEntry({ id: "e", whtForm: "pnd3", counterpartyTaxId: "2222222222229", lines: [mkLine({ amount: 900 })] }),
  ];

  it("pnd3 ได้เฉพาะ wht_form=pnd3 + มีเลขภาษี", () => {
    const r = buildPndReport(entries, "pnd3");
    expect(r.records.map((x) => x.entryId)).toEqual(["a"]);
    expect(r.totals.count).toBe(1);
    expect(r.totals.paidTotal).toBe(25000);
    expect(r.totals.whtTotal).toBe(750);
  });

  it("pnd53 ได้เฉพาะ wht_form=pnd53", () => {
    const r = buildPndReport(entries, "pnd53");
    expect(r.records.map((x) => x.entryId)).toEqual(["b"]);
    expect(r.totals.whtTotal).toBe(900);
  });

  it("wht_form=null → เข้ากลุ่ม unspecifiedForm (ไม่เดา)", () => {
    const r = buildPndReport(entries, "pnd3");
    expect(r.issues.unspecifiedForm.map((x) => x.entryId)).toEqual(["c"]);
  });

  it("ไม่มีเลขภาษี → เข้ากลุ่ม missingTaxId + ตัดออกจาก records", () => {
    const r = buildPndReport(entries, "pnd3");
    expect(r.issues.missingTaxId.map((x) => x.entryId)).toEqual(["d"]);
    expect(r.records.map((x) => x.entryId)).not.toContain("d");
  });

  it("บิลไม่มี wht → toWhtRecord คืน null", () => {
    expect(toWhtRecord(entries[4])).toBeNull();
  });
});

describe("rd-export: .txt ภ.ง.ด. — คั่น | + วันที่ พ.ศ.", () => {
  const entries = [
    mkEntry({
      id: "a", whtForm: "pnd3", counterpartyName: "นายเอ", counterpartyTaxId: "3101500889247",
      docDate: "2026-01-04",
      lines: [mkLine({ accountName: "ค่าบริการ", amount: 25000, whtRate: 3, whtAmount: 750 })],
    }),
  ];

  it("1 บรรทัด = 1 การจ่าย, จำนวนฟิลด์ตรงกับ PND_FIELDS, คั่นด้วย |", () => {
    const r = buildPndReport(entries, "pnd3");
    const lines = buildPndTextLines(r);
    expect(lines).toHaveLength(1);
    const cells = lines[0].split(RD_FIELD_SEP);
    expect(cells).toHaveLength(PND_FIELDS.length);
    // ลำดับ|taxid|สาขา|คำนำหน้า|ชื่อ|นามสกุล|วันจ่าย|ประเภท|อัตรา|จ่าย|หัก|เงื่อนไข
    expect(cells[0]).toBe("1");
    expect(cells[1]).toBe("3101500889247");
    expect(cells[2]).toBe("00000");
    expect(cells[4]).toBe("นายเอ");
    expect(cells[6]).toBe("04/01/2569"); // พ.ศ.
    expect(cells[8]).toBe("3.00");
    expect(cells[9]).toBe("25000.00");
    expect(cells[10]).toBe("750.00");
    expect(cells[11]).toBe("1");
  });

  it("ไม่มีแถวรวม/หัวในไฟล์ .txt (เฉพาะ record ที่ยื่นได้)", () => {
    const r = buildPndReport(entries, "pnd3");
    const text = joinRdLines(buildPndTextLines(r));
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("rd-export: จัดกลุ่มตามผู้มีเงินได้ (Excel ใบแนบ)", () => {
  it("payee เดียวจ่ายหลายบิล → 1 กลุ่ม หลายการจ่าย + subtotal", () => {
    const entries = [
      mkEntry({ id: "b1", whtForm: "pnd53", counterpartyName: "บ.บี", counterpartyTaxId: "0105565114216",
        lines: [mkLine({ accountName: "ค่าบริการ", amount: 30000, whtRate: 3, whtAmount: 900 })] }),
      mkEntry({ id: "b2", whtForm: "pnd53", counterpartyName: "บ.บี", counterpartyTaxId: "0105565114216",
        lines: [mkLine({ accountName: "ค่าบริการ", amount: 24000, whtRate: 3, whtAmount: 720 })] }),
    ];
    const r = buildPndReport(entries, "pnd53");
    const groups = groupWhtByPayee(r.records);
    expect(groups).toHaveLength(1);
    expect(groups[0].payments).toHaveLength(2);
    expect(groups[0].subtotalPaid).toBe(54000);
    expect(groups[0].subtotalWht).toBe(1620);
  });
});

describe("rd-export: ภ.พ.30 — รายงานภาษีขาย/ซื้อ", () => {
  const entries = [
    mkEntry({ id: "s1", entryType: "sale", docNo: "INV-1", buyerName: "ผู้ซื้อ ก", buyerTaxId: "0105560000001",
      lines: [mkLine({ amount: 1000, vatAmount: 70 })] }),
    mkEntry({ id: "s2", entryType: "sale", docNo: "INV-2", counterpartyName: "ผู้ซื้อสด", counterpartyTaxId: null,
      lines: [mkLine({ amount: 500, vatAmount: 35 })] }),
    mkEntry({ id: "p1", entryType: "purchase", docNo: "PV-1", sellerName: "ผู้ขาย ข", sellerTaxId: "0105560000002",
      lines: [mkLine({ amount: 2000, vatAmount: 140 })] }),
    // ขายแต่ไม่มี vat → ไม่เข้ารายงาน
    mkEntry({ id: "s3", entryType: "sale", lines: [mkLine({ amount: 800, vatAmount: 0 })] }),
  ];

  it("ภาษีขาย: เฉพาะ sale ที่มี vat + ใช้ชื่อผู้ซื้อ + รวมท้าย", () => {
    const r = buildPp30Report(entries, "sale");
    expect(r.records.map((x) => x.entryId)).toEqual(["s1", "s2"]);
    expect(r.totals.baseTotal).toBe(1500);
    expect(r.totals.vatTotal).toBe(105);
    expect(r.records[0].partyName).toBe("ผู้ซื้อ ก");
  });

  it("ภาษีซื้อ: เฉพาะ purchase ที่มี vat + ใช้ชื่อผู้ขาย", () => {
    const r = buildPp30Report(entries, "purchase");
    expect(r.records.map((x) => x.entryId)).toEqual(["p1"]);
    expect(r.records[0].partyName).toBe("ผู้ขาย ข");
    expect(r.totals.vatTotal).toBe(140);
  });

  it("เตือนใบกำกับที่ไม่มีเลขภาษี (ยังอยู่ในรายงาน)", () => {
    const r = buildPp30Report(entries, "sale");
    expect(r.warnings.missingTaxId).toBe(1); // s2 ไม่มีเลขภาษี
  });

  it(".txt ภ.พ.30 คั่น | + จำนวนฟิลด์ตรงกับ pp30Fields + วันที่ พ.ศ.", () => {
    const r = buildPp30Report(entries, "sale");
    const lines = buildPp30TextLines(r);
    expect(lines).toHaveLength(2);
    const cells = lines[0].split(RD_FIELD_SEP);
    expect(cells).toHaveLength(pp30Fields("sale").length);
    expect(cells[1]).toBe("05/07/2569"); // docDate 2026-07-05 พ.ศ.
    expect(cells[2]).toBe("INV-1");
    expect(cells[6]).toBe("1000.00");
    expect(cells[7]).toBe("70.00");
  });
});

describe("rd-export: encoding (.txt) — produce bytes", () => {
  it("default = TIS-620", () => {
    expect(resolveTxtEncoding()).toBe("tis-620");
  });

  it("TIS-620: อักขระไทยอยู่ช่วง 0xA1–0xFB, ASCII คงเดิม", () => {
    const buf = encodeRdText("กA|1", "tis-620");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf[0]).toBe(0xa1); // ก
    expect(buf[1]).toBe(0x41); // A
    expect(buf[2]).toBe(0x7c); // |
    expect(buf[3]).toBe(0x31); // 1
  });

  it("UTF-8: encode ตรง (ไทย = หลายไบต์)", () => {
    const buf = encodeRdText("ก", "utf-8");
    expect(buf.length).toBe(3); // ก = 3 bytes ใน utf-8
  });
});

describe("rd-export: Excel สร้างไฟล์จริงได้", () => {
  const pndEntries = [
    mkEntry({ id: "a", whtForm: "pnd3", counterpartyName: "นายเอ", counterpartyTaxId: "3101500889247",
      docDate: "2026-01-04",
      lines: [mkLine({ accountName: "ค่าบริการ", amount: 25000, whtRate: 3, whtAmount: 750 })] }),
  ];

  it("ภ.ง.ด.3 → Buffer อ่านกลับได้ + ชื่อชีท ภ.ง.ด.3 + มีเลขภาษีผู้หักบนหัว", async () => {
    const r = buildPndReport(pndEntries, "pnd3");
    const buf = await buildPndWorkbook(r, {
      entityLabel: "N001 · ทดสอบ", periodLabel: "ม.ค. 2569", payerTaxId: "0105567064992",
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets.map((w) => w.name)).toContain("ภ.ง.ด.3");
  });

  it("ภ.พ.30 ภาษีขาย → Buffer อ่านกลับได้", async () => {
    const r = buildPp30Report(
      [mkEntry({ id: "s1", entryType: "sale", buyerTaxId: "0105560000001", lines: [mkLine({ amount: 1000, vatAmount: 70 })] })],
      "sale"
    );
    const buf = await buildPp30Workbook(r, { entityLabel: "x", periodLabel: "y" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets.map((w) => w.name)).toContain("รายงานภาษีขาย");
  });
});
