/**
 * Excel export ภาษีซื้อ/ขาย — สร้างไฟล์ .xlsx จริง (2 ชีท) ด้วย exceljs
 *   ชีท "ภาษีซื้อ" (purchase) + "ภาษีขาย" (sale)
 *   แถว = แต่ละ line ของ entry (บิลผสม VAT/novat แตกหลายแถว) + แถวรวมท้าย
 *
 * ★ pure: รับ entries (จาก listEntries) → คืน Buffer — ไม่แตะ DB/network
 * ★ ภาษาไทย: หัวคอลัมน์/ชื่อชีทเป็นไทย · ตัวเลขจัด format ทศนิยม 2
 * ★ PDPA: ไม่ log เนื้อบิล — ผู้เรียก (server action) เป็นคน gate สิทธิ์ + สั่งดาวน์โหลด
 */
import ExcelJS from "exceljs";
import type { BillEntry } from "@/lib/accounting/queries";
import { lineNet, round2 } from "@/lib/accounting/queries";

/** หัวคอลัมน์ (ตามสเปก: วันที่/เลขที่/คู่ค้า/เลขภาษี/มูลค่า/VAT/หักณที่จ่าย/รวมจ่ายจริง/ภงด) */
const COLUMNS: { header: string; key: string; width: number }[] = [
  { header: "วันที่", key: "docDate", width: 12 },
  { header: "เลขที่เอกสาร", key: "docNo", width: 18 },
  { header: "คู่ค้า", key: "counterparty", width: 28 },
  { header: "เลขประจำตัวผู้เสียภาษี", key: "taxId", width: 20 },
  { header: "รายการ", key: "description", width: 28 },
  { header: "รหัสบัญชี", key: "accountCode", width: 12 },
  { header: "ชื่อบัญชี", key: "accountName", width: 24 },
  { header: "ประเภท VAT", key: "vatType", width: 10 },
  { header: "มูลค่า", key: "amount", width: 14 },
  { header: "VAT", key: "vat", width: 12 },
  { header: "หัก ณ ที่จ่าย", key: "wht", width: 14 },
  { header: "รวมจ่ายจริง", key: "net", width: 14 },
  { header: "ภ.ง.ด.", key: "whtForm", width: 10 },
];

const NUMBER_FMT = "#,##0.00";
const MONEY_KEYS = new Set(["amount", "vat", "wht", "net"]);

/** ป้ายภาษาไทยของ ภ.ง.ด. */
function whtFormLabel(form: string | null): string {
  if (form === "pnd3") return "ภ.ง.ด.3";
  if (form === "pnd53") return "ภ.ง.ด.53";
  return "";
}

/** ป้าย VAT ภาษาไทย */
function vatTypeLabel(vatType: string): string {
  return vatType === "novat" ? "ไม่มี VAT" : "VAT 7%";
}

/** วันที่ ISO (YYYY-MM-DD) → วันที่/เดือน/ปี พ.ศ. — ผู้ใช้สั่ง 2026-09-02 (เดิมโชว์ ปี-เดือน-วัน ดิบ) */
function thaiDateDMY(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso;
}

/** เรียงบิลตามวันที่เอกสาร เก่า→ใหม่ (ไม่มีวันที่ = ท้ายสุด · เท่ากันเรียงต่อด้วยเลขที่) */
function byDocDateAsc(a: BillEntry, b: BillEntry): number {
  if (a.docDate && b.docDate) {
    if (a.docDate !== b.docDate) return a.docDate < b.docDate ? -1 : 1;
  } else if (a.docDate) {
    return -1;
  } else if (b.docDate) {
    return 1;
  }
  return (a.docNo ?? "").localeCompare(b.docNo ?? "", "th");
}

/** เขียน 1 ชีทของประเภทเอกสาร (purchase/sale) — คืนยอดรวมไว้ทำสรุปนอกได้ */
function writeSheet(ws: ExcelJS.Worksheet, entries: BillEntry[]): void {
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  // สไตล์แถวหัว
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };

  let sumAmount = 0;
  let sumVat = 0;
  let sumWht = 0;
  let sumNet = 0;

  for (const e of [...entries].sort(byDocDateAsc)) {
    // entry ที่ไม่มี line เลย → ใส่ 1 แถวหัวเปล่า (ให้เห็นว่ามีบิลนี้)
    const lines = e.lines.length > 0 ? e.lines : [null];
    for (const l of lines) {
      const amount = l ? round2(l.amount) : 0;
      const vat = l ? round2(l.vatAmount) : 0;
      const wht = l ? round2(l.whtAmount) : 0;
      const net = l ? lineNet(l) : 0;
      sumAmount = round2(sumAmount + amount);
      sumVat = round2(sumVat + vat);
      sumWht = round2(sumWht + wht);
      sumNet = round2(sumNet + net);

      ws.addRow({
        docDate: thaiDateDMY(e.docDate),
        docNo: e.docNo ?? "",
        counterparty: e.counterpartyName ?? "",
        taxId: e.counterpartyTaxId ?? "",
        description: l?.description ?? "",
        accountCode: l?.accountCode ?? "",
        accountName: l?.accountName ?? "",
        vatType: l ? vatTypeLabel(l.vatType) : "",
        amount,
        vat,
        wht,
        net,
        whtForm: whtFormLabel(e.whtForm),
      });
    }
  }

  // แถวรวมท้าย
  const totalRow = ws.addRow({
    description: "รวมทั้งสิ้น",
    amount: sumAmount,
    vat: sumVat,
    wht: sumWht,
    net: sumNet,
  });
  totalRow.font = { bold: true };

  // format ตัวเลขทุกคอลัมน์เงิน
  ws.columns.forEach((col) => {
    if (col.key && MONEY_KEYS.has(col.key)) {
      col.numFmt = NUMBER_FMT;
    }
  });
}

/**
 * สร้าง workbook 2 ชีท (ภาษีซื้อ/ภาษีขาย) จาก entries ทั้งชุด
 *   @returns Buffer ของไฟล์ .xlsx
 */
export async function buildBillEntriesWorkbook(entries: BillEntry[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  wb.created = new Date();

  const purchases = entries.filter((e) => e.entryType === "purchase");
  const sales = entries.filter((e) => e.entryType === "sale");

  writeSheet(wb.addWorksheet("ภาษีซื้อ"), purchases);
  writeSheet(wb.addWorksheet("ภาษีขาย"), sales);

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
