/**
 * Excel export วงแชร์ — ชีท "ยื่น ภธ.40" (ภาษีธุรกิจเฉพาะ รายเดือน)
 *   คอลัมน์: เดือน / รายได้ท้าว (ΣG) / ค่าดูแลวง (ΣI) / รวม (ฐาน) /
 *            SBT 3% / ท้องถิ่น 10% / รวมเสียภาษี (3.3%)
 *
 * ★ pure: รับ entries (จาก listShareCircleEntries) → คืน Buffer (ไม่แตะ DB/network)
 * ★ ใช้ computeSbtMonthly เป็นแหล่งคำนวณเดียวกับ UI (สูตรตรงกันเป๊ะ)
 * ★ PDPA: ไม่ log เนื้อวง — ผู้เรียก (route) gate สิทธิ์ + สั่งดาวน์โหลด
 */
import ExcelJS from "exceljs";
import { computeSbtMonthly, type ShareCircleEntry } from "@/lib/share-circles/queries";

const NUMBER_FMT = "#,##0.00";

/** 'YYYY-MM' → 'MM/YYYY(พ.ศ.)' อ่านง่ายในไฟล์ */
function monthText(m: string): string {
  const mm = /^(\d{4})-(\d{2})$/.exec(m);
  if (!mm) return m;
  return `${mm[2]}/${parseInt(mm[1], 10) + 543}`;
}

/**
 * สร้าง workbook ชีท "ยื่น ภธ.40" จาก entries ของลูกค้า 1 ราย
 *   @returns Buffer ของไฟล์ .xlsx
 */
export async function buildShareCircleSbtWorkbook(entries: ShareCircleEntry[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  wb.created = new Date();

  const ws = wb.addWorksheet("ยื่น ภธ.40");
  ws.columns = [
    { header: "เดือน", key: "month", width: 14 },
    { header: "รายได้ท้าว", key: "g", width: 16 },
    { header: "ค่าดูแลวง", key: "i", width: 16 },
    { header: "รวม", key: "base", width: 16 },
    { header: "SBT 3%", key: "sbt3", width: 14 },
    { header: "ท้องถิ่น 10%", key: "local", width: 14 },
    { header: "รวมเสียภาษี", key: "total", width: 16 },
  ];
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };

  const rows = computeSbtMonthly(entries).sort((a, b) => a.month.localeCompare(b.month));
  let sg = 0;
  let si = 0;
  let sbase = 0;
  let ssbt = 0;
  let slocal = 0;
  let stotal = 0;
  for (const r of rows) {
    ws.addRow({
      month: monthText(r.month),
      g: r.baseG,
      i: r.baseI,
      base: r.base,
      sbt3: r.sbt3,
      local: r.local,
      total: r.total,
    });
    sg += r.baseG;
    si += r.baseI;
    sbase += r.base;
    ssbt += r.sbt3;
    slocal += r.local;
    stotal += r.total;
  }

  const totalRow = ws.addRow({
    month: "รวมทั้งปี",
    g: Math.round(sg * 100) / 100,
    i: Math.round(si * 100) / 100,
    base: Math.round(sbase * 100) / 100,
    sbt3: Math.round(ssbt * 100) / 100,
    local: Math.round(slocal * 100) / 100,
    total: Math.round(stotal * 100) / 100,
  });
  totalRow.font = { bold: true };

  // format ตัวเลขทุกคอลัมน์เงิน
  for (const key of ["g", "i", "base", "sbt3", "local", "total"]) {
    const col = ws.getColumn(key);
    col.numFmt = NUMBER_FMT;
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
