/**
 * platform-album-excel.ts — Excel "สรุปยอดขายแพลตฟอร์ม" ต่อลูกค้า 1 ราย
 *   ชีต: สรุปยอดขาย (ต่อแพลตฟอร์ม × 4 ตัวเลข + สุทธิ) · รายเดือน · _pdata (ซ่อน เก็บข้อมูลรีเจน)
 */
import ExcelJS from "exceljs";
import { PLATFORM_LABELS, type Platform } from "@/lib/accounting/platform/types";
import {
  byMonth,
  byPlatform,
  emptyPlatformAlbum,
  grandTotals,
  type PlatformAlbumStore,
  type PlatformFileRecord,
} from "@/lib/accounting/platform-album";

const PDATA = "_pdata";
const HEAD = ["sig", "platform", "month", "grossSales", "platformFee", "shippingFee", "discount"] as const;
const FIG_COLS = ["ยอดขายรวม", "ค่าธรรมเนียม/GP", "ค่าขนส่ง", "ส่วนลด", "สุทธิ"];

function platformLabel(p: string): string {
  return PLATFORM_LABELS[p as Platform] ?? p;
}

export async function buildPlatformAlbumWorkbook(input: { customerName: string; store: PlatformAlbumStore }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  const { store } = input;

  const money = (ws: ExcelJS.Worksheet, row: number, startCol: number, vals: number[]) => {
    vals.forEach((v, i) => { const c = ws.getCell(row, startCol + i); c.value = v; c.numFmt = "#,##0.00"; });
  };

  // ===== ชีต 1: สรุปยอดขาย (ต่อแพลตฟอร์ม) =====
  const s = wb.addWorksheet("สรุปยอดขาย");
  s.columns = [{ width: 20 }, { width: 15 }, { width: 15 }, { width: 13 }, { width: 13 }, { width: 15 }];
  s.getCell(1, 1).value = `สรุปยอดขายแพลตฟอร์ม — ${input.customerName}`;
  s.getCell(1, 1).font = { bold: true, size: 14 };
  ["แพลตฟอร์ม", ...FIG_COLS].forEach((h, i) => { const c = s.getCell(3, i + 1); c.value = h; c.font = { bold: true }; });
  let r = 4;
  for (const p of byPlatform(store)) {
    s.getCell(r, 1).value = platformLabel(p.platform);
    money(s, r, 2, [p.totals.grossSales, p.totals.platformFee, p.totals.shippingFee, p.totals.discount, p.totals.net]);
    r++;
  }
  const g = grandTotals(store);
  s.getCell(r, 1).value = "รวมทุกแพลตฟอร์ม"; s.getCell(r, 1).font = { bold: true };
  money(s, r, 2, [g.grossSales, g.platformFee, g.shippingFee, g.discount, g.net]);
  for (let c = 2; c <= 6; c++) s.getCell(r, c).font = { bold: true };

  // ===== ชีต 2: รายเดือน =====
  const m = wb.addWorksheet("รายเดือน");
  m.columns = [{ width: 14 }, { width: 15 }, { width: 15 }, { width: 13 }, { width: 13 }, { width: 15 }];
  m.getCell(1, 1).value = `ยอดขายแพลตฟอร์มรายเดือน — ${input.customerName}`;
  m.getCell(1, 1).font = { bold: true, size: 14 };
  ["เดือน", ...FIG_COLS].forEach((h, i) => { const c = m.getCell(3, i + 1); c.value = h; c.font = { bold: true }; });
  let mr = 4;
  for (const row of byMonth(store)) {
    m.getCell(mr, 1).value = row.month === "unknown" ? "ไม่ระบุเดือน" : row.month;
    money(m, mr, 2, [row.totals.grossSales, row.totals.platformFee, row.totals.shippingFee, row.totals.discount, row.totals.net]);
    mr++;
  }
  m.getCell(mr, 1).value = "รวม"; m.getCell(mr, 1).font = { bold: true };
  money(m, mr, 2, [g.grossSales, g.platformFee, g.shippingFee, g.discount, g.net]);
  for (let c = 2; c <= 6; c++) m.getCell(mr, c).font = { bold: true };

  // ===== _pdata ซ่อน =====
  const d = wb.addWorksheet(PDATA, { state: "veryHidden" });
  d.addRow(HEAD as unknown as string[]);
  for (const f of store.files) {
    for (const mo of f.months) d.addRow([f.sig, f.platform, mo.month, mo.grossSales, mo.platformFee, mo.shippingFee, mo.discount]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** อ่านกองกลับจาก _pdata (group ตาม sig) · ไม่มี/พัง → ว่าง */
export async function readPlatformAlbumFromWorkbook(buf: Buffer | null): Promise<PlatformAlbumStore> {
  if (!buf) return emptyPlatformAlbum();
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const d = wb.getWorksheet(PDATA);
    if (!d) return emptyPlatformAlbum();
    const str = (v: unknown): string => {
      if (v == null) return "";
      return String(typeof v === "object" && "text" in (v as object) ? (v as { text: unknown }).text : v).trim();
    };
    const numOf = (v: unknown): number => { const n = typeof v === "number" ? v : Number(str(v).replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
    const idx: Record<string, number> = {};
    d.getRow(1).eachCell({ includeEmpty: false }, (c, ci) => { const k = str(c.value); if (k) idx[k] = ci; });
    const col = (name: string) => idx[name] ?? 0;
    const bySig = new Map<string, PlatformFileRecord>();
    d.eachRow((row, rn) => {
      if (rn === 1) return;
      const cell = (i: number) => (i > 0 ? row.getCell(i).value : null);
      const sig = str(cell(col("sig")));
      if (!sig) return;
      const rec = bySig.get(sig) ?? { sig, platform: str(cell(col("platform"))), months: [] };
      rec.months.push({
        month: str(cell(col("month"))) || "unknown",
        grossSales: numOf(cell(col("grossSales"))),
        platformFee: numOf(cell(col("platformFee"))),
        shippingFee: numOf(cell(col("shippingFee"))),
        discount: numOf(cell(col("discount"))),
      });
      bySig.set(sig, rec);
    });
    return { v: 1, files: [...bySig.values()] };
  } catch {
    return emptyPlatformAlbum();
  }
}
