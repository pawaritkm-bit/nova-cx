/**
 * ออกเอกสารสรุปยอดสำหรับยื่น ภ.ง.ด.1 (wishlist ข้อ 5) — pure builder (input → Excel Buffer)
 *
 * ★★ ไม่มี e-filing API ตรงกับ efiling.rd.go.th (ยืนยันจาก docs/06-accounting-features-roadmap.md เฟส 9
 *    หมวด "0.3 ไม่มี e-filing จริง" — แม้ FlowAccount เองก็ทำได้แค่คำนวณ+ออกเอกสารให้ดาวน์โหลด ไม่มีใคร
 *    ยื่นตรงได้) — ไฟล์นี้จึงเป็นแค่ "เอกสารสรุปยอด" ให้นักบัญชีเอาไปกรอกในเว็บกรมสรรพากรเอง ไม่ใช่ไฟล์
 *    นำเข้า/อัปโหลดอัตโนมัติ (ผู้ใช้ยืนยันขอบเขต Excel เท่านั้น — ไม่มี .txt แบบ RD Prep เหมือน rd-export.ts
 *    เพราะยังไม่เคยยืนยัน layout ของ ภ.ง.ด.1 กับ RD Prep จริง)
 * ★ PDPA: เลขบัตรประชาชนที่นี่เป็นค่าเต็มไม่มาสก์ — เอกสารยื่นสรรพากรจำเป็นต้องใช้เลขเต็ม ผู้เรียก (route)
 *   ต้อง gate สิทธิ์ (requireAccountingAccess + customerInScope) ก่อนเรียกใช้ไฟล์นี้เสมอ — มิเรอร์
 *   rd-export.ts ที่อ่าน counterparty_tax_id แบบเต็มไม่มาสก์เช่นกัน (เอกสารยื่นต้องมีเลขเต็ม)
 * ★ ไม่ log ค่าใด ๆ — ผู้เรียก (route) เป็นคน gate สิทธิ์ + สโคปลูกค้า
 */
import ExcelJS from "exceljs";
import { round2 } from "@/lib/accounting/queries";
import type { Pnd1EmployeeTotal } from "@/lib/accounting/payroll-monthly-filing";

const MONEY_FMT = "#,##0.00";

export type Pnd1Report = {
  records: Pnd1EmployeeTotal[];
  totals: { count: number; grossTotal: number; pitTotal: number };
};

/**
 * สร้างรายงาน ภ.ง.ด.1 จากยอดรวมต่อพนักงาน — กรองพนักงานที่ไม่มีเงินได้และไม่มีภาษีหักเลยออก (ไม่มีอะไรต้องยื่น)
 *   ★ เช็คทั้ง grossIncome และ pitWithheld (ไม่เช็คแค่ grossIncome > 0) — กัน edge case ที่ทฤษฎีไม่ควรเกิด
 *     (PIT เป็นฟังก์ชันของ gross เสมอ) แต่ถ้าข้อมูลผิดปกติจริง (rounding ฯลฯ) จนเหลือ pitWithheld > 0 ทั้งที่
 *     grossIncome คำนวณได้ 0 พอดี ก็ต้องไม่ตัดพนักงานคนนั้นออกจากเอกสารยื่นสรรพากรไปเงียบ ๆ
 */
export function buildPnd1Report(totals: Pnd1EmployeeTotal[]): Pnd1Report {
  const records = totals.filter((t) => t.grossIncome > 0 || t.pitWithheld > 0);
  const grossTotal = round2(records.reduce((s, r) => s + r.grossIncome, 0));
  const pitTotal = round2(records.reduce((s, r) => s + r.pitWithheld, 0));
  return { records, totals: { count: records.length, grossTotal, pitTotal } };
}

export type Pnd1ExcelHeader = {
  /** ป้ายกิจการ/ลูกค้า (เช่น "N023 · บริษัท ...") */
  entityLabel: string;
  /** ป้ายงวด (เช่น "ส.ค. 2569") */
  periodLabel: string;
  /** เลขผู้เสียภาษีของนายจ้าง (ลูกค้าเรา) · null = ไม่มี */
  payerTaxId?: string | null;
};

const PND1_COLUMNS: ReadonlyArray<{ header: string; width: number; money?: boolean }> = [
  { header: "ลำดับ", width: 8 },
  { header: "รหัสพนักงาน", width: 14 },
  { header: "ชื่อ-นามสกุล", width: 28 },
  { header: "เลขประจำตัวประชาชน/พาสปอร์ต", width: 22 },
  { header: "เงินได้ (ก่อนหัก)", width: 16, money: true },
  { header: "ภาษีหัก ณ ที่จ่าย", width: 16, money: true },
];

/** สร้าง Excel สรุปยอดยื่น ภ.ง.ด.1 — หัวเรื่อง + ตารางต่อพนักงาน + แถวรวมท้าย */
export async function buildPnd1Workbook(report: Pnd1Report, header: Pnd1ExcelHeader): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NOVA-CX";
  wb.created = new Date();
  const ws = wb.addWorksheet("ภ.ง.ด.1");

  ws.addRow(["สรุปยอดสำหรับยื่น ภ.ง.ด.1"]).font = { bold: true, size: 14 };
  ws.addRow([`เลขประจำตัวผู้เสียภาษีอากร (นายจ้าง): ${header.payerTaxId ?? "-"}`]);
  ws.addRow([header.entityLabel]);
  ws.addRow([`งวด: ${header.periodLabel}`]);
  ws.addRow([]);

  const head = ws.addRow(PND1_COLUMNS.map((c) => c.header));
  head.font = { bold: true };
  head.alignment = { horizontal: "center", vertical: "middle", wrapText: true };

  report.records.forEach((r, i) => {
    ws.addRow([
      i + 1,
      r.employeeCode ?? "",
      r.fullName,
      r.idCardNo ?? r.passportNo ?? "",
      round2(r.grossIncome),
      round2(r.pitWithheld),
    ]);
  });

  const total = ws.addRow([
    "",
    "",
    "รวมทั้งสิ้น",
    `${report.totals.count} คน`,
    round2(report.totals.grossTotal),
    round2(report.totals.pitTotal),
  ]);
  total.font = { bold: true };

  ws.columns.forEach((c, i) => (c.width = PND1_COLUMNS[i]?.width ?? 16));
  PND1_COLUMNS.forEach((c, i) => {
    if (c.money) ws.getColumn(i + 1).numFmt = MONEY_FMT;
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
