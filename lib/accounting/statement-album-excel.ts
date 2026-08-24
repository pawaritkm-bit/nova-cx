/**
 * statement-album-excel.ts — สร้าง Excel "สรุปสเตทเมนต์" ของลูกค้า 1 ราย · 1 ชีต/ธนาคาร (+ ชีตสรุป)
 *   ★ pure (ไม่ log เนื้อ/ยอด — PDPA) · รับกอง txns ต่อธนาคารจาก AlbumStore
 */
import ExcelJS from "exceljs";
import type { StatementTxn } from "@/lib/accounting/statement-analyze";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** ชื่อชีตที่ Excel ยอมรับ (≤31 ตัว, ไม่มี \ / ? * [ ] :) + กันชื่อซ้ำ */
function safeSheetName(name: string, used: Set<string>): string {
  let base = (name || "ธนาคาร").replace(/[\\/?*[\]:]+/g, " ").trim().slice(0, 28) || "ธนาคาร";
  let n = base;
  let i = 2;
  while (used.has(n)) {
    n = `${base} ${i++}`.slice(0, 31);
  }
  used.add(n);
  return n;
}

function sortTxns(txns: StatementTxn[]): StatementTxn[] {
  return txns.slice().sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
}

/**
 * สร้าง workbook สรุปสเตทเมนต์ → Buffer
 *   @param customerName ชื่อลูกค้า (หัวเรื่อง)
 *   @param banks map ป้ายธนาคาร → รายการธุรกรรม
 */
export async function buildStatementAlbumWorkbook(input: {
  customerName: string;
  banks: Record<string, StatementTxn[]>;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";

  const bankLabels = Object.keys(input.banks).sort((a, b) => a.localeCompare(b, "th"));

  // ===== ชีตสรุป (ภาพรวมทุกธนาคาร) =====
  const s = wb.addWorksheet("สรุปรวม");
  s.columns = [{ width: 30 }, { width: 16 }, { width: 16 }, { width: 12 }];
  s.getCell(1, 1).value = `สรุปสเตทเมนต์ — ${input.customerName}`;
  s.getCell(1, 1).font = { bold: true, size: 14 };
  const head = ["ธนาคาร", "เงินเข้า (บาท)", "เงินออก (บาท)", "จำนวนรายการ"];
  head.forEach((h, i) => {
    const c = s.getCell(3, i + 1);
    c.value = h;
    c.font = { bold: true };
  });
  let sumIn = 0;
  let sumOut = 0;
  let sumCount = 0;
  let r = 4;
  const used = new Set<string>();
  const perBankSheetName = new Map<string, string>();

  for (const label of bankLabels) {
    const txns = input.banks[label] ?? [];
    let bIn = 0;
    let bOut = 0;
    for (const t of txns) {
      const amt = typeof t.amount === "number" ? Math.abs(t.amount) : 0;
      if (t.direction === "in") bIn += amt;
      else if (t.direction === "out") bOut += amt;
    }
    bIn = round2(bIn);
    bOut = round2(bOut);
    s.getCell(r, 1).value = label;
    s.getCell(r, 2).value = bIn;
    s.getCell(r, 3).value = bOut;
    s.getCell(r, 4).value = txns.length;
    sumIn += bIn;
    sumOut += bOut;
    sumCount += txns.length;
    r++;
    perBankSheetName.set(label, safeSheetName(label, used));
  }
  // แถวรวม
  s.getCell(r + 1, 1).value = "รวมทุกธนาคาร";
  s.getCell(r + 1, 1).font = { bold: true };
  s.getCell(r + 1, 2).value = round2(sumIn);
  s.getCell(r + 1, 3).value = round2(sumOut);
  s.getCell(r + 1, 4).value = sumCount;
  s.getCell(r + 1, 2).font = { bold: true };
  s.getCell(r + 1, 3).font = { bold: true };
  s.getCell(r + 1, 4).font = { bold: true };

  // ===== 1 ชีต/ธนาคาร (รายการธุรกรรม) =====
  for (const label of bankLabels) {
    const ws = wb.addWorksheet(perBankSheetName.get(label)!);
    ws.columns = [{ width: 12 }, { width: 40 }, { width: 24 }, { width: 10 }, { width: 16 }];
    ws.getCell(1, 1).value = label;
    ws.getCell(1, 1).font = { bold: true, size: 12 };
    const cols = ["วันที่", "รายละเอียด", "คู่ค้า", "ทิศทาง", "จำนวนเงิน"];
    cols.forEach((h, i) => {
      const c = ws.getCell(3, i + 1);
      c.value = h;
      c.font = { bold: true };
    });
    let row = 4;
    let tIn = 0;
    let tOut = 0;
    for (const t of sortTxns(input.banks[label] ?? [])) {
      ws.getCell(row, 1).value = t.date ?? "";
      ws.getCell(row, 2).value = t.description ?? "";
      ws.getCell(row, 3).value = t.counterparty_name ?? "";
      ws.getCell(row, 4).value = t.direction === "in" ? "เงินเข้า" : t.direction === "out" ? "เงินออก" : "";
      ws.getCell(row, 5).value = typeof t.amount === "number" ? t.amount : "";
      const amt = typeof t.amount === "number" ? Math.abs(t.amount) : 0;
      if (t.direction === "in") tIn += amt;
      else if (t.direction === "out") tOut += amt;
      row++;
    }
    ws.getCell(row + 1, 4).value = "รวมเงินเข้า";
    ws.getCell(row + 1, 4).font = { bold: true };
    ws.getCell(row + 1, 5).value = round2(tIn);
    ws.getCell(row + 2, 4).value = "รวมเงินออก";
    ws.getCell(row + 2, 4).font = { bold: true };
    ws.getCell(row + 2, 5).value = round2(tOut);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
