/**
 * สร้างสลิปเงินเดือนเป็น PDF (wishlist ข้อ 6 — ส่งสลิปเงินเดือนเป็นชุดทางอีเมล) — pure builder
 *   (input → PDF Buffer) mirror รายการ/ป้ายชื่อบรรทัดเดียวกับ SlipView.tsx (สลิปที่พิมพ์บนจอ) เป๊ะ ๆ
 *   เพื่อให้สลิปที่ส่งอีเมลกับที่เห็นบนจอตรงกันทุกตัวเลข
 *
 * ★ ใช้ lib/pdf/thai-text.ts วาดข้อความผสมไทย/เลข/วรรคตอน (pdfkit เดี่ยว ๆ ไม่รองรับ)
 * ★ PDPA: ไม่ log ชื่อ/เงินเดือนใด ๆ ในไฟล์นี้ — ผู้เรียกเป็นคน gate สิทธิ์มาก่อนแล้ว
 */
import PDFDocument from "pdfkit";
import { registerThaiFonts, drawMixedText, drawMixedTextRightAligned, FONT_THAI } from "@/lib/pdf/thai-text";
import { formatMoney } from "@/lib/accounting/calc";
import type { PayrollRun, PayrollRunLine } from "@/lib/accounting/payroll";

const MONTH_LABELS = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

const PAGE_LEFT = 50;
const PAGE_RIGHT = 545;
const ROW_HEIGHT = 20;

/** สร้าง PDF สลิปเงินเดือน 1 ใบของพนักงาน 1 คนในรอบ 1 รอบ */
export function buildPayslipPdfBuffer(run: PayrollRun, line: PayrollRunLine): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // ★ font:false — ปิด default font "Helvetica" ที่ pdfkit โหลดอัตโนมัติตอนสร้าง doc (initFonts) เสมอ
    //   ปกติไม่มีปัญหา แต่ในบริบท Next.js server bundle (webpack) ไฟล์ data/Helvetica.afm ของ pdfkit เอง
    //   หาไม่พบตอน runtime (ENOENT) — เราลงทะเบียน+ใช้ฟอนต์ไทย/ละตินเองทั้งหมดอยู่แล้ว ไม่ต้องพึ่ง Helvetica
    const doc = new PDFDocument({ size: "A4", margin: 50, font: false as unknown as string });
    registerThaiFonts(doc);
    doc.font(FONT_THAI);

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    let y = PAGE_LEFT;
    drawMixedText(doc, "สลิปเงินเดือน", PAGE_LEFT, y, 16);
    y += ROW_HEIGHT + 8;
    drawMixedText(
      doc,
      `งวด ${MONTH_LABELS[run.payPeriodMonth] ?? ""} ${run.payPeriodYear} · วันที่จ่าย ${run.payDate}`,
      PAGE_LEFT,
      y,
      10
    );
    y += ROW_HEIGHT + 12;

    const row = (label: string, value: string, size = 10) => {
      drawMixedText(doc, label, PAGE_LEFT, y, size);
      drawMixedTextRightAligned(doc, value, PAGE_RIGHT, y, size);
      y += ROW_HEIGHT;
    };

    row("ชื่อ-นามสกุล", line.employeeFullName, 11);
    if (line.employeeCode) row("รหัสพนักงาน", line.employeeCode);
    row("เงินเดือน/ค่าจ้าง", formatMoney(line.grossSalary));
    row("รายรับเพิ่มเติม", formatMoney(line.otherAdditions));
    row("โบนัส", formatMoney(line.bonusAmount));
    if (line.severanceAmount > 0) row("ค่าชดเชยเลิกจ้าง", formatMoney(line.severanceAmount));
    row(
      "รวมเงินได้",
      formatMoney(line.grossSalary + line.otherAdditions + line.bonusAmount + line.severanceAmount),
      11
    );
    row("หัก: ภาษีหัก ณ ที่จ่าย", formatMoney(line.pitWithheld));
    if (line.severanceAmount > 0) {
      row("หัก: ภาษีหัก ณ ที่จ่าย (ค่าชดเชย)", formatMoney(line.severancePitWithheld));
    }
    row("หัก: ประกันสังคม (ลูกจ้าง)", formatMoney(line.ssoEmployee));
    row("หัก: รายการหักอื่น ๆ", formatMoney(line.otherDeductions));
    row("เงินเดือนสุทธิ (รับจริง)", formatMoney(line.netPay), 11);
    row("ประกันสังคม (ส่วนนายจ้าง — นายจ้างสมทบให้ ไม่หักจากพนักงาน)", formatMoney(line.ssoEmployer));

    doc.end();
  });
}

/** ชื่อไฟล์แนบ — ASCII เท่านั้น (กัน mail client บางตัวแสดง filename ที่มี UTF-8 เพี้ยน) ไม่มี PII ในชื่อไฟล์ */
export function payslipFilename(run: PayrollRun, line: PayrollRunLine): string {
  const codePart = (line.employeeCode ?? line.payrollEmployeeId.slice(0, 8)).replace(/[^\w.-]/g, "");
  return `payslip_${codePart}_${run.payPeriodYear}-${String(run.payPeriodMonth).padStart(2, "0")}.pdf`;
}

/** หัวข้อ+เนื้อหาอีเมล (plain text) — PDF แนบเป็นตัวเนื้อหาหลัก อีเมลเป็นแค่ข้อความสั้นแจ้งว่ามีสลิปแนบมา */
export function buildPayslipEmailContent(
  run: PayrollRun,
  line: PayrollRunLine
): { subject: string; text: string } {
  const periodLabel = `${MONTH_LABELS[run.payPeriodMonth] ?? ""} ${run.payPeriodYear}`;
  return {
    subject: `สลิปเงินเดือน — งวด ${periodLabel}`,
    text: `เรียน ${line.employeeFullName}\n\nแนบสลิปเงินเดือนงวด ${periodLabel} (วันที่จ่าย ${run.payDate}) มาด้วยแล้ว\n\nอีเมลนี้ส่งโดยระบบอัตโนมัติ กรุณาอย่าตอบกลับ`,
  };
}
