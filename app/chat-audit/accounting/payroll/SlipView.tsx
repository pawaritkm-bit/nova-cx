"use client";

import type { PayrollRun, PayrollRunLine } from "@/lib/accounting/payroll";
import { formatMoney } from "@/lib/accounting/calc";

/**
 * SlipView — สลิปเงินเดือนรายบุคคล (หน้าพิมพ์ CSS, mirror รูปแบบเฟส 4) — เฟส 9 ส่วน AE (T119)
 *   เปิดเป็น modal overlay ในจอ — กด "พิมพ์" ใช้ CSS `@media print` (`.payroll-slip-print`,
 *   accounting.css) ซ่อนทุกอย่างในหน้ายกเว้นสลิปตอนพิมพ์/บันทึก PDF
 */

const MONTH_LABELS = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

export default function SlipView({
  line,
  run,
  onClose,
}: {
  line: PayrollRunLine;
  run: PayrollRun;
  onClose: () => void;
}) {
  return (
    <div className="acc-modal-scrim">
      <div className="acc-modal-backdrop" onClick={onClose} />
      <div className="acc-modal acc-modal-sm payroll-slip-print">
        <div className="acc-modal-head">
          <span className="acc-modal-title">สลิปเงินเดือน</span>
          <button type="button" className="acc-modal-close no-print" onClick={onClose} aria-label="ปิด">×</button>
        </div>
        <div className="acc-modal-sub">
          งวด {MONTH_LABELS[run.payPeriodMonth]} {run.payPeriodYear} · วันที่จ่าย {run.payDate}
        </div>

        <table className="dlv-table acc-table" style={{ marginTop: 10 }}>
          <tbody>
            <tr><td>ชื่อ-นามสกุล</td><td className="num strong">{line.employeeFullName}</td></tr>
            {line.employeeCode ? <tr><td>รหัสพนักงาน</td><td className="num">{line.employeeCode}</td></tr> : null}
            <tr><td>เงินเดือน/ค่าจ้าง</td><td className="num">{formatMoney(line.grossSalary)}</td></tr>
            <tr><td>รายรับเพิ่มเติม</td><td className="num">{formatMoney(line.otherAdditions)}</td></tr>
            <tr><td>โบนัส</td><td className="num">{formatMoney(line.bonusAmount)}</td></tr>
            <tr><td className="strong">รวมเงินได้</td><td className="num strong">{formatMoney(line.grossSalary + line.otherAdditions + line.bonusAmount)}</td></tr>
            <tr><td>หัก: ภาษีหัก ณ ที่จ่าย</td><td className="num">{formatMoney(line.pitWithheld)}</td></tr>
            <tr><td>หัก: ประกันสังคม (ลูกจ้าง)</td><td className="num">{formatMoney(line.ssoEmployee)}</td></tr>
            <tr><td>หัก: รายการหักอื่น ๆ</td><td className="num">{formatMoney(line.otherDeductions)}</td></tr>
            <tr className="acc-total"><td className="strong">เงินเดือนสุทธิ (รับจริง)</td><td className="num strong">{formatMoney(line.netPay)}</td></tr>
            <tr><td className="muted">ประกันสังคม (ส่วนนายจ้าง — นายจ้างสมทบให้ ไม่หักจากพนักงาน)</td><td className="num muted">{formatMoney(line.ssoEmployer)}</td></tr>
          </tbody>
        </table>

        <div className="acc-modal-actions no-print">
          <button type="button" className="btn" onClick={() => window.print()}>พิมพ์ / บันทึก PDF</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>ปิด</button>
        </div>
      </div>
    </div>
  );
}
