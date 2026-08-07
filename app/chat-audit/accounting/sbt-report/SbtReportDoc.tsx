"use client";

import { useState } from "react";
import { formatMoney, parseAmountInput } from "@/lib/accounting/calc";
import { calcSbt } from "@/lib/accounting/sbt-report";

/**
 * รายงาน ภธ.40 (ภาษีธุรกิจเฉพาะ) — เอกสารพิมพ์/บันทึก PDF (ต่อลูกค้า/เดือน)
 *
 * ★ Phase 1: "ฐานภาษี" กรอก/แก้ได้ (client) — ตั้งค่าเริ่มต้น = รายได้ฝั่งขายก่อน VAT ของเดือนนั้น
 *   แล้วคิด SBT 3% + ภาษีท้องถิ่น 10% (รวม 3.3%) ให้อัตโนมัติ. แก้ฐานแล้วตัวเลขอัปเดตทันที.
 * ★ reuse สไตล์ vr-* (vat-report.css) — พิมพ์สะอาด, ซ่อน .no-print
 * ★ ไม่ยิง network · PDPA: ไม่ log ค่าใด ๆ
 */
export default function SbtReportDoc({
  companyName,
  companyTaxId,
  companyAddress,
  monthLabel,
  printedAt,
  defaultBase,
  backHref,
}: {
  companyName: string;
  companyTaxId: string;
  companyAddress: string;
  monthLabel: string;
  printedAt: string;
  /** ฐานเริ่มต้น = รายได้ฝั่งขายก่อน VAT ของเดือน (แก้ได้) */
  defaultBase: number;
  backHref: string;
}) {
  // เก็บเป็น string เพื่อให้พิมพ์/ลบได้ลื่น — คำนวณจาก parseAmountInput
  const [baseText, setBaseText] = useState<string>(
    defaultBase > 0 ? String(defaultBase) : ""
  );
  const base = parseAmountInput(baseText);
  const calc = calcSbt(base);

  return (
    <div className="vr-shell">
      {/* ---- แถบเครื่องมือ (ซ่อนตอนพิมพ์) ---- */}
      <div className="vr-toolbar no-print">
        <a href={backHref} className="vr-btn vr-btn-ghost">← กลับ</a>
        <span className="vr-toolbar-hint">
          กรอก/แก้ “ฐานภาษี” ให้ตรงนิยาม ภธ.40 ของกิจการ แล้วกดพิมพ์
        </span>
        <button type="button" className="vr-btn vr-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
      </div>

      {/* คำเตือน/สมมติฐาน — โชว์บนจอ ไม่พิมพ์ (ให้นักบัญชีเห็นก่อนออกเอกสาร) */}
      <div className="vr-note no-print">
        <strong>โปรดตรวจสอบก่อนใช้งาน (ภธ.40):</strong>
        <ul>
          <li>ภาษีธุรกิจเฉพาะใช้กับ “บางกิจการ” เท่านั้น (ธนาคาร/ไฟแนนซ์/อสังหาฯ/โรงรับจำนำ ฯลฯ) — ธุรกิจทั่วไปมักไม่ต้องยื่น</li>
          <li>“ฐานภาษี” ตั้งค่าเริ่มต้นจากรายได้ฝั่งขายก่อน VAT ของเดือนเท่านั้น — ต้องแก้ให้ตรงนิยามฐาน ภธ.40 จริงของกิจการ</li>
          <li>อัตรา = ภาษีธุรกิจเฉพาะ 3% + ภาษีท้องถิ่น 10% ของภาษีธุรกิจเฉพาะ (รวม 3.3% ของฐาน)</li>
        </ul>
      </div>

      {/* ================= ตัวเอกสาร ================= */}
      <div className="vr-page">
        {/* หัวรายงาน 3 คอลัมน์ */}
        <div className="vr-head">
          <div className="vr-head-left">
            <div>วันที่พิมพ์ {printedAt}</div>
          </div>
          <div className="vr-head-center">
            <div className="vr-title">- แบบ ภธ.40 ภาษีธุรกิจเฉพาะ -</div>
            <div className="vr-company">{companyName}</div>
            <div className="vr-address">{companyAddress || " "}</div>
            <div className="vr-month">เดือนภาษี {monthLabel}</div>
          </div>
          <div className="vr-head-right">
            <div>Page 1</div>
            <div>สำนักงานใหญ่</div>
            <div>เลขประจำตัวผู้เสียภาษี {companyTaxId || "-"}</div>
          </div>
        </div>

        {/* ช่องกรอกฐาน (ซ่อนตอนพิมพ์ — ตอนพิมพ์เห็นค่าในตารางแทน) */}
        <div className="vr-baseedit no-print">
          <label htmlFor="sbt-base">ฐานภาษี (บาท):</label>
          <input
            id="sbt-base"
            type="text"
            inputMode="decimal"
            value={baseText}
            onChange={(e) => setBaseText(e.target.value)}
            placeholder="0.00"
          />
        </div>

        {/* ตารางคำนวณ */}
        <table className="vr-table">
          <thead>
            <tr>
              <th>รายการ</th>
              <th className="vr-col-money">จำนวนเงิน (บาท)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>ฐานภาษี (รายรับตามเกณฑ์ ภธ.40)</td>
              <td className="vr-c-money">{formatMoney(calc.base)}</td>
            </tr>
            <tr>
              <td>ภาษีธุรกิจเฉพาะ (3% ของฐาน)</td>
              <td className="vr-c-money">{formatMoney(calc.sbt)}</td>
            </tr>
            <tr>
              <td>ภาษีท้องถิ่น (10% ของภาษีธุรกิจเฉพาะ)</td>
              <td className="vr-c-money">{formatMoney(calc.localTax)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="vr-total">
              <td className="vr-total-label">รวมภาษีที่ต้องนำส่ง (3.3% ของฐาน)</td>
              <td className="vr-c-money">{formatMoney(calc.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
