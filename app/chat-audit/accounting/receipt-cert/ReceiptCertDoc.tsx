"use client";

import { useMemo, useState } from "react";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";
import { bahtText } from "@/lib/accounting/baht-text";

/** 1 รายการในใบรับรอง (รายการ + จำนวนเงิน) */
export type ReceiptCertItem = {
  description: string;
  amount: number;
};

/** แถวในฟอร์ม — เก็บ amount เป็น string เพื่อให้พิมพ์/แก้ได้ลื่น (parse ตอนคำนวณ) */
type Row = {
  key: number;
  description: string;
  amount: string;
};

/**
 * ใบรับรองแทนใบเสร็จรับเงิน — เอกสารที่ "แก้ไขช่องได้" + พิมพ์/บันทึก PDF ผ่านเบราว์เซอร์
 *
 * ★ ทุกช่องเป็น input/textarea (แก้ก่อนพิมพ์ได้) · ปุ่ม/แถบเครื่องมือซ่อนตอนพิมพ์ (print CSS)
 * ★ ยอดรวม = ผลบวกทุกแถว (parse robust) + แปลงเป็นตัวอักษรไทยอัตโนมัติ (bahtText)
 * ★ เพิ่ม/ลบแถวได้ · หัวกระดาษ (ชื่อกิจการ/เลขภาษี) prefill จากลูกค้า แต่ยังแก้ได้
 * ★ ไม่ยิง network — เอกสารทำงานฝั่ง client ล้วน (Phase 1 ไม่บันทึก DB)
 */
export default function ReceiptCertDoc({
  businessName,
  taxId,
  payerName,
  docDate,
  items,
  backHref,
}: {
  businessName: string;
  taxId: string;
  payerName: string;
  docDate: string;
  items: ReceiptCertItem[];
  backHref: string;
}) {
  // ---- state หัวกระดาษ/เอกสาร (แก้ได้ทุกช่อง) ----
  const [bizName, setBizName] = useState(businessName);
  const [bizAddress, setBizAddress] = useState("");
  const [bizTaxId, setBizTaxId] = useState(taxId);
  const [docNo, setDocNo] = useState("");
  const [date, setDate] = useState(docDate);
  const [payer, setPayer] = useState(payerName);
  const [payeeName, setPayeeName] = useState("");
  const [payeeAddress, setPayeeAddress] = useState("");

  // ---- state ตารางรายการ ----
  const [rows, setRows] = useState<Row[]>(() =>
    (items.length > 0 ? items : [{ description: "", amount: 0 }]).map((it, i) => ({
      key: i,
      description: it.description,
      amount: it.amount ? String(it.amount) : "",
    }))
  );
  const [nextKey, setNextKey] = useState(rows.length);

  const total = useMemo(
    () => rows.reduce((sum, r) => sum + parseAmountInput(r.amount), 0),
    [rows]
  );
  const totalText = useMemo(() => bahtText(total), [total]);

  function updateRow(key: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { key: nextKey, description: "", amount: "" }]);
    setNextKey((k) => k + 1);
  }
  function removeRow(key: number) {
    // กันลบจนไม่เหลือแถว (อย่างน้อย 1 แถว)
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.key !== key)));
  }

  return (
    <div className="rcv-shell">
      {/* ---- แถบเครื่องมือ (ซ่อนตอนพิมพ์) ---- */}
      <div className="rcv-toolbar no-print">
        <a href={backHref} className="rcv-btn rcv-btn-ghost">
          ← กลับ
        </a>
        <span className="rcv-toolbar-hint">
          แก้ข้อความในเอกสารได้ทุกช่อง แล้วกด “พิมพ์ / บันทึก PDF”
        </span>
        <button type="button" className="rcv-btn rcv-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
      </div>

      {/* ================= ตัวเอกสาร (A4) ================= */}
      <div className="rcv-page">
        {/* หัวกระดาษ = ข้อมูลลูกค้า (ผู้จ่าย/ผู้รับรอง) */}
        <div className="rcv-head">
          <input
            className="rcv-in rcv-bizname"
            value={bizName}
            onChange={(e) => setBizName(e.target.value)}
            placeholder="ชื่อกิจการ / ชื่อผู้รับรอง"
            aria-label="ชื่อกิจการ"
          />
          <textarea
            className="rcv-in rcv-address"
            value={bizAddress}
            onChange={(e) => setBizAddress(e.target.value)}
            placeholder="ที่อยู่กิจการ"
            rows={2}
            aria-label="ที่อยู่กิจการ"
          />
          <div className="rcv-taxline">
            <span className="rcv-label">เลขประจำตัวผู้เสียภาษี:</span>
            <input
              className="rcv-in rcv-taxid"
              value={bizTaxId}
              onChange={(e) => setBizTaxId(e.target.value)}
              placeholder="—"
              aria-label="เลขประจำตัวผู้เสียภาษี"
            />
          </div>
        </div>

        <h1 className="rcv-title">ใบรับรองแทนใบเสร็จรับเงิน</h1>

        {/* เลขที่ + วันที่ */}
        <div className="rcv-meta">
          <div className="rcv-meta-item">
            <span className="rcv-label">เลขที่</span>
            <input
              className="rcv-in rcv-docno"
              value={docNo}
              onChange={(e) => setDocNo(e.target.value)}
              placeholder="เช่น 2569/001"
              aria-label="เลขที่เอกสาร"
            />
          </div>
          <div className="rcv-meta-item">
            <span className="rcv-label">วันที่</span>
            <input
              className="rcv-in rcv-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              placeholder="วว/ดด/ปปปป"
              aria-label="วันที่"
            />
          </div>
        </div>

        {/* คำรับรอง */}
        <p className="rcv-statement">
          ข้าพเจ้า{" "}
          <input
            className="rcv-in rcv-payer"
            value={payer}
            onChange={(e) => setPayer(e.target.value)}
            placeholder="ชื่อผู้จ่ายเงิน"
            aria-label="ชื่อผู้จ่ายเงิน"
          />{" "}
          ขอรับรองว่าได้จ่ายเงินตามรายการข้างล่างนี้จริง
          เนื่องจากผู้รับเงินไม่สามารถออกใบเสร็จรับเงินให้ได้
        </p>

        {/* ตารางรายการ */}
        <table className="rcv-table">
          <thead>
            <tr>
              <th className="rcv-col-no">ลำดับ</th>
              <th className="rcv-col-desc">รายการ</th>
              <th className="rcv-col-amt">จำนวนเงิน (บาท)</th>
              <th className="rcv-col-del no-print" aria-label="ลบ" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.key}>
                <td className="rcv-col-no">{idx + 1}</td>
                <td>
                  <input
                    className="rcv-in rcv-cell"
                    value={r.description}
                    onChange={(e) => updateRow(r.key, { description: e.target.value })}
                    placeholder="รายละเอียดค่าใช้จ่าย"
                    aria-label={`รายการที่ ${idx + 1}`}
                  />
                </td>
                <td className="rcv-col-amt">
                  <input
                    className="rcv-in rcv-cell rcv-cell-amt"
                    value={r.amount}
                    onChange={(e) => updateRow(r.key, { amount: e.target.value })}
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label={`จำนวนเงินรายการที่ ${idx + 1}`}
                  />
                </td>
                <td className="rcv-col-del no-print">
                  <button
                    type="button"
                    className="rcv-row-del"
                    onClick={() => removeRow(r.key)}
                    disabled={rows.length <= 1}
                    aria-label="ลบแถว"
                    title="ลบแถว"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} className="rcv-total-label">
                รวมเงินทั้งสิ้น
              </td>
              <td className="rcv-col-amt rcv-total-amt">{formatMoney(total)}</td>
              <td className="no-print" />
            </tr>
          </tfoot>
        </table>

        {/* ปุ่มเพิ่มแถว (ซ่อนตอนพิมพ์) */}
        <div className="no-print rcv-addrow-wrap">
          <button type="button" className="rcv-btn rcv-btn-ghost" onClick={addRow}>
            ＋ เพิ่มรายการ
          </button>
        </div>

        {/* ยอดรวมเป็นตัวอักษร */}
        <p className="rcv-amount-text">
          <span className="rcv-label">ตัวอักษร</span>
          <span className="rcv-amount-words">({totalText})</span>
        </p>

        {/* ผู้รับเงิน */}
        <div className="rcv-payee">
          <div className="rcv-payee-line">
            <span className="rcv-label">ผู้รับเงิน</span>
            <input
              className="rcv-in rcv-payee-name"
              value={payeeName}
              onChange={(e) => setPayeeName(e.target.value)}
              placeholder="ชื่อผู้รับเงิน"
              aria-label="ชื่อผู้รับเงิน"
            />
          </div>
          <div className="rcv-payee-line">
            <span className="rcv-label">ที่อยู่</span>
            <textarea
              className="rcv-in rcv-payee-address"
              value={payeeAddress}
              onChange={(e) => setPayeeAddress(e.target.value)}
              placeholder="ที่อยู่ผู้รับเงิน"
              rows={2}
              aria-label="ที่อยู่ผู้รับเงิน"
            />
          </div>
        </div>

        {/* ช่องลงชื่อ */}
        <div className="rcv-sign">
          <div className="rcv-sign-box">
            <div className="rcv-sign-line" />
            <div className="rcv-sign-label">( ลงชื่อ ) ผู้จ่ายเงิน / ผู้รับรอง</div>
          </div>
        </div>
      </div>
    </div>
  );
}
