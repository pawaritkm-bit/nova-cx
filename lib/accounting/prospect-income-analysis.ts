/**
 * prospect-income-analysis.ts — สร้างไฟล์ Excel "รายละเอียดเงินเข้า (วิเคราะห์รายรับว่าที่ลูกค้า)"
 *   สำหรับฝั่งขาย (sales pitch) — รวมสเตทเมนต์หลายธนาคาร/หลายเดือนของว่าที่ลูกค้า 1 ราย
 *
 * เฟส 1 (ตัวเลขล้วน — deterministic, ไม่พึ่ง AI):
 *   - ชีต "ประวัติลูกค้า": ช่องข้อมูลบัตรประชาชน + ฝังรูปบัตร (หน้า/หลัง) ถ้ามี
 *   - ชีต "รายละเอียดเงินเข้า": ตารางเงินเข้าต่อเดือน × ต่อธนาคาร + จำนวนครั้ง + รวมเงินเข้า/เดือน
 *     + รวมทั้งปี + เตือนเมื่อเกิน 1.8 ล้าน (ต้องจด VAT / ควรตั้งนิติบุคคล)
 *   - บล็อกเทียบภาษี (เฟส 2) เว้นไว้ก่อน
 *
 * ★ PDPA: ฟังก์ชัน pure — ไม่ log เนื้อ/ยอด/เลขบัตร · รูปบัตรฝังในไฟล์ที่เก็บโฟลเดอร์ลูกค้าเท่านั้น
 * ★ อัตราเหมา/ภาษี (เฟส 2) อ้างประมวลรัษฎากร ม.40 + พรฎ.629 — จะเติมตอนทำเทียบภาษี
 */
import ExcelJS from "exceljs";

/** เพดานเงินได้ก่อนต้องจด VAT (บาท/ปี) */
export const VAT_REGISTRATION_THRESHOLD = 1_800_000;

const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** ประวัติ/KYC ว่าที่ลูกค้า (ได้จากรูปบัตร ปชช. / แชท) */
export type ProspectProfile = {
  taxpayerName?: string | null;
  /** เลขบัตรประชาชน 13 หลัก = เลขประจำตัวผู้เสียภาษีของบุคคลธรรมดา */
  idCardNo?: string | null;
  address?: string | null;
  dob?: string | null;
  cardIssue?: string | null;
  cardExpiry?: string | null;
  /** เลขหลังบัตร (laser code) */
  laserCode?: string | null;
  note?: string | null;
  /** รูปบัตร (ฝังลงชีต) */
  idCardFront?: Buffer | null;
  idCardFrontMime?: string | null;
  idCardBack?: Buffer | null;
  idCardBackMime?: string | null;
};

/** ยอดเงินเข้าของธนาคารหนึ่ง แยกรายเดือน (month = 1..12) */
export type BankMonthly = { month: number; totalIn: number; count: number };

export type BankSummary = {
  /** ป้ายธนาคาร เช่น "กสิกร #3789" */
  bankLabel: string;
  monthly: BankMonthly[];
  /** ยอดคงเหลือปลายงวด (ถ้าอ่านได้) */
  closingBalance?: number | null;
};

export type ProspectIncomeInput = {
  /** ชื่อว่าที่ลูกค้า (ใช้ตั้งหัวเรื่อง/ชื่อไฟล์) */
  customerName: string;
  /** ปี ค.ศ. (แสดงเป็น พ.ศ. ในไฟล์) */
  year: number;
  profile: ProspectProfile;
  banks: BankSummary[];
};

/** รวมธุรกรรม (เฉพาะเงินเข้า) เป็นยอด/จำนวนครั้ง รายเดือน — helper (pure) */
export function aggregateBankMonthly(
  txns: { date: string | null; direction: "in" | "out" | null; amount: number | null }[],
  year: number
): BankMonthly[] {
  const acc = new Map<number, { totalIn: number; count: number }>();
  for (const t of txns) {
    if (t.direction !== "in" || t.amount == null || !t.date) continue;
    const m = /^(\d{4})-(\d{2})-/.exec(t.date);
    if (!m || parseInt(m[1], 10) !== year) continue;
    const mo = parseInt(m[2], 10);
    const cur = acc.get(mo) ?? { totalIn: 0, count: 0 };
    cur.totalIn = Math.round((cur.totalIn + Math.abs(t.amount)) * 100) / 100;
    cur.count += 1;
    acc.set(mo, cur);
  }
  return [...acc.entries()].map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month - b.month);
}

function imgExt(mime?: string | null): "jpeg" | "png" {
  return (mime || "").toLowerCase().includes("png") ? "png" : "jpeg";
}

/** สร้าง workbook → Buffer (xlsx) พร้อมเขียนลง OneDrive/ส่งกลับ */
export async function buildProspectIncomeWorkbook(input: ProspectIncomeInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  const beYear = input.year + 543;

  // ===== ชีต 1: ประวัติลูกค้า =====
  const p = wb.addWorksheet("ประวัติลูกค้า");
  p.columns = [{ width: 22 }, { width: 34 }, { width: 4 }, { width: 22 }, { width: 34 }];
  const pf = input.profile;
  const put = (row: number, label: string, val: string | null | undefined, col = 1) => {
    p.getCell(row, col).value = label;
    p.getCell(row, col).font = { bold: true };
    p.getCell(row, col + 1).value = val ?? "";
  };
  p.getCell(1, 1).value = `ประวัติลูกค้า — ${input.customerName}`;
  p.getCell(1, 1).font = { bold: true, size: 14 };
  put(3, "ผู้เสียภาษี", pf.taxpayerName);
  put(3, "เลขบัตร (เลขภาษี)", pf.idCardNo, 4);
  put(4, "ที่อยู่", pf.address);
  put(4, "เลขหลังบัตร", pf.laserCode, 4);
  put(5, "เกิดวันที่", pf.dob);
  put(5, "รหัสยื่นสรรพากร", pf.idCardNo, 4); // บุคคลธรรมดา = เลขบัตร
  put(6, "วันออกบัตร", pf.cardIssue);
  put(6, "บัตรหมดอายุ", pf.cardExpiry, 4);
  put(7, "หมายเหตุ", pf.note);

  // ฝังรูปบัตร (หน้า/หลัง) ถ้ามี
  let imgRow = 9;
  if (pf.idCardFront && pf.idCardFront.length > 0) {
    p.getCell(imgRow, 1).value = "บัตรประชาชน (ด้านหน้า)";
    p.getCell(imgRow, 1).font = { bold: true };
    const id = wb.addImage({ buffer: pf.idCardFront as unknown as ExcelJS.Buffer, extension: imgExt(pf.idCardFrontMime) });
    p.addImage(id, { tl: { col: 0, row: imgRow }, ext: { width: 340, height: 214 } });
    imgRow += 13;
  }
  if (pf.idCardBack && pf.idCardBack.length > 0) {
    p.getCell(imgRow, 1).value = "บัตรประชาชน (ด้านหลัง)";
    p.getCell(imgRow, 1).font = { bold: true };
    const id = wb.addImage({ buffer: pf.idCardBack as unknown as ExcelJS.Buffer, extension: imgExt(pf.idCardBackMime) });
    p.addImage(id, { tl: { col: 0, row: imgRow }, ext: { width: 340, height: 214 } });
  }

  // ===== ชีต 2: รายละเอียดเงินเข้า =====
  const s = wb.addWorksheet("รายละเอียดเงินเข้า");
  const banks = input.banks;
  // แถวหัวเรื่อง
  s.getCell(1, 1).value = `รายละเอียดเงินเข้า ${input.customerName} — ปี ${beYear}`;
  s.getCell(1, 1).font = { bold: true, size: 14 };

  // แถวหัวคอลัมน์ (แถว 3): เดือน | [ธนาคาร: ยอด, ครั้ง]... | รวมเงินเข้า
  const headRow = 3;
  s.getCell(headRow, 1).value = "เดือน";
  let col = 2;
  const bankCols: { amt: number; cnt: number }[] = [];
  for (const b of banks) {
    s.getCell(headRow, col).value = b.bankLabel;
    s.getCell(headRow, col + 1).value = "ครั้ง";
    bankCols.push({ amt: col, cnt: col + 1 });
    col += 2;
  }
  const totalCol = col;
  s.getCell(headRow, totalCol).value = "รวมเงินเข้า";
  s.getRow(headRow).font = { bold: true };
  s.getRow(headRow).alignment = { horizontal: "center" };

  // ดัชนียอดต่อเดือนของแต่ละธนาคาร
  const byBankMonth = banks.map((b) => {
    const m = new Map<number, BankMonthly>();
    for (const x of b.monthly) m.set(x.month, x);
    return m;
  });

  // 12 แถวเดือน + รวมท้าย
  const monthTotals: number[] = [];
  const bankYearTotals = banks.map(() => 0);
  for (let mo = 1; mo <= 12; mo++) {
    const r = headRow + mo;
    s.getCell(r, 1).value = TH_MONTHS[mo - 1];
    let rowTotal = 0;
    banks.forEach((_, bi) => {
      const cell = byBankMonth[bi].get(mo);
      const amt = cell?.totalIn ?? 0;
      const cnt = cell?.count ?? 0;
      if (amt > 0) {
        s.getCell(r, bankCols[bi].amt).value = amt;
        s.getCell(r, bankCols[bi].amt).numFmt = "#,##0.00";
        s.getCell(r, bankCols[bi].cnt).value = cnt;
        rowTotal += amt;
        bankYearTotals[bi] += amt;
      }
    });
    if (rowTotal > 0) {
      s.getCell(r, totalCol).value = rowTotal;
      s.getCell(r, totalCol).numFmt = "#,##0.00";
    }
    monthTotals.push(rowTotal);
  }

  // แถวรวมทั้งปี
  const sumRow = headRow + 13;
  s.getCell(sumRow, 1).value = "รวมทั้งปี";
  s.getCell(sumRow, 1).font = { bold: true };
  banks.forEach((_, bi) => {
    s.getCell(sumRow, bankCols[bi].amt).value = bankYearTotals[bi];
    s.getCell(sumRow, bankCols[bi].amt).numFmt = "#,##0.00";
    s.getCell(sumRow, bankCols[bi].amt).font = { bold: true };
  });
  const grandTotal = monthTotals.reduce((a, b) => a + b, 0);
  s.getCell(sumRow, totalCol).value = grandTotal;
  s.getCell(sumRow, totalCol).numFmt = "#,##0.00";
  s.getCell(sumRow, totalCol).font = { bold: true };

  // แถวคงเหลือ (ถ้ามี)
  if (banks.some((b) => b.closingBalance != null)) {
    const balRow = sumRow + 1;
    s.getCell(balRow, 1).value = "คงเหลือปลายงวด";
    banks.forEach((b, bi) => {
      if (b.closingBalance != null) {
        s.getCell(balRow, bankCols[bi].amt).value = b.closingBalance;
        s.getCell(balRow, bankCols[bi].amt).numFmt = "#,##0.00";
      }
    });
  }

  // เตือน 1.8 ล้าน
  const warnRow = sumRow + 3;
  if (grandTotal > VAT_REGISTRATION_THRESHOLD) {
    const c = s.getCell(warnRow, 1);
    c.value = `⚠ เงินเข้ารวมทั้งปี ${grandTotal.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท — เกิน 1,800,000 → ต้องจด VAT / ควรพิจารณาตั้งนิติบุคคลเพื่อวางแผนภาษี`;
    c.font = { bold: true, color: { argb: "FFB91C1C" } };
  } else {
    s.getCell(warnRow, 1).value = `เงินเข้ารวมทั้งปี ${grandTotal.toLocaleString("th-TH", { minimumFractionDigits: 2 })} บาท (ยังไม่ถึงเกณฑ์จด VAT 1.8 ล้าน)`;
  }

  // หมายเหตุเฟส 2
  s.getCell(warnRow + 2, 1).value = "* บล็อกเทียบภาษี บุคคลธรรมดา (เหมา/ตามจริง) vs นิติบุคคล จะเพิ่มในเฟสถัดไป";
  s.getCell(warnRow + 2, 1).font = { italic: true, color: { argb: "FF6B7280" } };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
