/**
 * statement-album-excel.ts — สร้าง Excel "สรุปสเตทเมนต์" ของลูกค้า 1 ราย · 1 ชีต/ธนาคาร (+ ชีตสรุป)
 *   ★ pure (ไม่ log เนื้อ/ยอด — PDPA) · รับกอง txns ต่อธนาคารจาก AlbumStore
 */
import ExcelJS from "exceljs";
import type { StatementTxn } from "@/lib/accounting/statement-analyze";
import type { AlbumStore } from "@/lib/accounting/statement-album";
import { emptyAlbum } from "@/lib/accounting/statement-album";

/** ชื่อชีตซ่อนที่เก็บ "ข้อมูลดิบต่อธนาคาร" ไว้ในไฟล์เดียว (แทน sidecar JSON) — อ่านกลับตอนรีเจน */
const DATA_SHEET = "_data";
const DATA_HEADER = ["bank", "date", "description", "counterparty", "direction", "amount"] as const;

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

  // ===== ชีตซ่อน _data: เก็บข้อมูลดิบต่อธนาคาร ไว้ในไฟล์เดียว (แทน sidecar JSON — ไม่รกโฟลเดอร์) =====
  const d = wb.addWorksheet(DATA_SHEET, { state: "veryHidden" });
  d.addRow(DATA_HEADER as unknown as string[]);
  for (const label of bankLabels) {
    for (const t of input.banks[label] ?? []) {
      d.addRow([label, t.date ?? "", t.description ?? "", t.counterparty_name ?? "", t.direction ?? "", typeof t.amount === "number" ? t.amount : ""]);
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/** อ่านกอง AlbumStore กลับจากชีตซ่อน _data ของไฟล์ Excel เดิม · ไม่มี/พัง → กองว่าง (เริ่มใหม่) */
export async function readAlbumFromWorkbook(buf: Buffer | null): Promise<AlbumStore> {
  if (!buf) return emptyAlbum();
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const d = wb.getWorksheet(DATA_SHEET);
    if (!d) return emptyAlbum();
    const banks: Record<string, StatementTxn[]> = {};
    d.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const cell = (i: number) => row.getCell(i).value;
      const str = (v: unknown): string | null => {
        if (v == null) return null;
        const s = String(typeof v === "object" && "text" in (v as object) ? (v as { text: unknown }).text : v).trim();
        return s || null;
      };
      const bank = str(cell(1)) || "";
      if (!bank) return;
      const dirRaw = str(cell(5));
      const direction = dirRaw === "in" ? "in" : dirRaw === "out" ? "out" : null;
      const amtRaw = cell(6);
      const amount = typeof amtRaw === "number" ? amtRaw : amtRaw != null && amtRaw !== "" ? Number(String(amtRaw).replace(/,/g, "")) : null;
      const txn: StatementTxn = {
        date: str(cell(2)),
        description: str(cell(3)),
        counterparty_name: str(cell(4)),
        counterparty_account_no: null,
        direction,
        amount: Number.isFinite(amount as number) ? (amount as number) : null,
      };
      (banks[bank] ??= []).push(txn);
    });
    return { v: 2, banks };
  } catch {
    return emptyAlbum();
  }
}
