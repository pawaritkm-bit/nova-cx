"use client";

import { useMemo, useState } from "react";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";
import { bahtText } from "@/lib/accounting/baht-text";

/** 1 รายการในใบรับรอง (วันที่ / รายละเอียด / จำนวนเงิน / หมายเหตุ) */
export type ReceiptCertItem = {
  date: string;
  description: string;
  amount: number;
  note: string;
};

/** แถวในฟอร์ม — เก็บ amount เป็น string เพื่อให้พิมพ์/แก้ได้ลื่น (parse ตอนคำนวณ) */
type Row = {
  key: number;
  date: string;
  description: string;
  amount: string;
  note: string;
};

/**
 * ใบรับรองแทนใบเสร็จรับเงิน — เอกสารที่ "แก้ไขช่องได้" + พิมพ์/บันทึก PDF ผ่านเบราว์เซอร์
 *
 * โครงตาม "ฟอร์มจริง" ที่ผู้ใช้ส่งมา:
 *   หัว: ชื่อเรื่อง → "[ชื่อผู้ซื้อ] (ผู้ซื้อ)" → "เลขประจำตัวผู้เสียภาษีอากร [tax id]"
 *   มุมขวาบน: เลขที่ / วันที่
 *   ตาราง 4 คอลัมน์: วัน เดือน ปี | รายละเอียดค่าจ่าย | จำนวนเงิน | หมายเหตุ
 *   รวมทั้งสิ้น + ตัวอักษร (bahtText)
 *   ย่อหน้ารับรอง (ข้าพเจ้า/ตำแหน่ง/เนื่องจาก/ช่วงวันที่) แก้ได้ทุกช่อง
 *   ช่องหมายเหตุเพิ่มเติม + ลายเซ็น 2 ช่อง (ผู้เบิกจ่าย/ผู้อนุมัติ)
 *
 * ★ ทุกช่องเป็น input/textarea (แก้ก่อนพิมพ์ได้) · ปุ่ม/เครื่องมือซ่อนตอนพิมพ์ (.no-print)
 * ★ ยอดรวม = ผลบวกทุกแถว (parse robust) + แปลงเป็นตัวอักษรไทยอัตโนมัติ (bahtText)
 * ★ ไม่ยิง network — เอกสารทำงานฝั่ง client ล้วน (Phase 1 ไม่บันทึก DB)
 */
export default function ReceiptCertDoc({
  customerName,
  taxId,
  docDate,
  items,
  backHref,
}: {
  /** ชื่อผู้ซื้อ/ผู้เบิกจ่าย (default = ผู้ติดต่อ หรือ ชื่อกิจการลูกค้า) */
  customerName: string;
  taxId: string;
  /** วันที่เอกสาร (มุมขวาบน) dd/mm/พ.ศ. */
  docDate: string;
  items: ReceiptCertItem[];
  backHref: string;
}) {
  // ---- หัวเอกสาร / meta ----
  const [buyerName, setBuyerName] = useState(customerName);
  const [buyerTaxId, setBuyerTaxId] = useState(taxId);
  const [docNo, setDocNo] = useState("");
  const [date, setDate] = useState(docDate);

  // ---- ย่อหน้ารับรอง ----
  const [payer, setPayer] = useState(customerName);
  const [position, setPosition] = useState("เจ้าของกิจการ");
  const [reason, setReason] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  // ---- หมายเหตุเพิ่มเติม (ล่างสุด) ----
  const [extraNote, setExtraNote] = useState("");

  // ---- ตารางรายการ ----
  const [rows, setRows] = useState<Row[]>(() =>
    (items.length > 0 ? items : [{ date: "", description: "", amount: 0, note: "" }]).map(
      (it, i) => ({
        key: i,
        date: it.date,
        description: it.description,
        amount: it.amount ? String(it.amount) : "",
        note: it.note,
      })
    )
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
    setRows((prev) => [...prev, { key: nextKey, date: "", description: "", amount: "", note: "" }]);
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
        {/* เลขที่ / วันที่ (มุมขวาบน) */}
        <div className="rcv-topmeta">
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

        {/* หัวเอกสาร (กลาง) = ชื่อเรื่อง → ผู้ซื้อ → เลขภาษี */}
        <div className="rcv-head">
          <h1 className="rcv-title">ใบรับรองแทนใบเสร็จรับเงิน</h1>
          <div className="rcv-buyerline">
            <input
              className="rcv-in rcv-buyer"
              value={buyerName}
              onChange={(e) => setBuyerName(e.target.value)}
              placeholder="ชื่อผู้ซื้อ"
              aria-label="ชื่อผู้ซื้อ"
              size={30}
            />
            <span className="rcv-buyer-suffix"> (ผู้ซื้อ)</span>
          </div>
          <div className="rcv-taxline">
            <span>เลขประจำตัวผู้เสียภาษีอากร</span>
            <input
              className="rcv-in rcv-taxid"
              value={buyerTaxId}
              onChange={(e) => setBuyerTaxId(e.target.value)}
              placeholder="—"
              aria-label="เลขประจำตัวผู้เสียภาษีอากร"
              size={20}
            />
          </div>
        </div>

        {/* ตารางรายการ 4 คอลัมน์ */}
        <table className="rcv-table">
          <thead>
            <tr>
              <th className="rcv-col-date">วัน เดือน ปี</th>
              <th className="rcv-col-desc">รายละเอียดค่าจ่าย</th>
              <th className="rcv-col-amt">จำนวนเงิน</th>
              <th className="rcv-col-note">หมายเหตุ</th>
              <th className="rcv-col-del no-print" aria-label="ลบ" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.key}>
                <td className="rcv-col-date">
                  <input
                    className="rcv-in rcv-cell rcv-cell-date"
                    value={r.date}
                    onChange={(e) => updateRow(r.key, { date: e.target.value })}
                    placeholder="วว/ดด/ปปปป"
                    aria-label={`วันที่รายการที่ ${idx + 1}`}
                  />
                </td>
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
                <td className="rcv-col-note">
                  <input
                    className="rcv-in rcv-cell"
                    value={r.note}
                    onChange={(e) => updateRow(r.key, { note: e.target.value })}
                    placeholder=""
                    aria-label={`หมายเหตุรายการที่ ${idx + 1}`}
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
              <td className="rcv-total-label">รวมทั้งสิ้น</td>
              <td />
              <td className="rcv-col-amt rcv-total-amt">{formatMoney(total)}</td>
              <td>บาท</td>
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
          <span className="rcv-label">จำนวนเงิน (ตัวอักษร)</span>
          <span className="rcv-amount-words">({totalText})</span>
        </p>

        {/* ย่อหน้ารับรอง */}
        <p className="rcv-statement">
          ข้าพเจ้า{" "}
          <input
            className="rcv-in rcv-inline rcv-inline-name"
            value={payer}
            onChange={(e) => setPayer(e.target.value)}
            placeholder="ชื่อผู้เบิกจ่าย"
            aria-label="ชื่อผู้เบิกจ่าย"
            size={22}
          />{" "}
          (ผู้เบิกจ่าย) ตำแหน่ง{" "}
          <input
            className="rcv-in rcv-inline"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            placeholder="ตำแหน่ง"
            aria-label="ตำแหน่ง"
            size={14}
          />{" "}
          ขอรับรองว่า รายจ่ายข้างต้นนี้ไม่อาจเรียกเก็บใบเสร็จจากผู้รับได้
          และข้าพเจ้าได้จ่ายชำระให้กับทาง{" "}
          <input
            className="rcv-in rcv-inline rcv-inline-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="ชื่อผู้รับเงิน"
            aria-label="ผู้รับเงิน"
            size={24}
          />{" "}
          โดยแท้ ตั้งแต่วันที่{" "}
          <input
            className="rcv-in rcv-inline rcv-inline-date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            placeholder="วว/ดด/ปปปป"
            aria-label="ตั้งแต่วันที่"
            size={10}
          />{" "}
          ถึงวันที่{" "}
          <input
            className="rcv-in rcv-inline rcv-inline-date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            placeholder="วว/ดด/ปปปป"
            aria-label="ถึงวันที่"
            size={10}
          />{" "}
          โดยให้ลูกจ้างในความดูแลเบิกเงินและนำไปชำระค่าสินค้าแทน
          ซึ่งข้าพเจ้าได้ตรวจสอบ และลงชื่ออนุมัติเสมอ
        </p>

        {/* หมายเหตุเพิ่มเติม (แก้ได้) */}
        <div className="rcv-extranote">
          <span className="rcv-label">หมายเหตุ</span>
          <textarea
            className="rcv-in rcv-extranote-box"
            value={extraNote}
            onChange={(e) => setExtraNote(e.target.value)}
            placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
            rows={2}
            aria-label="หมายเหตุเพิ่มเติม"
          />
        </div>

        {/* ช่องลงชื่อ 2 ช่อง */}
        <div className="rcv-sign">
          <div className="rcv-sign-box">
            <div className="rcv-sign-line" />
            <div className="rcv-sign-label">( ลงชื่อ ) ผู้เบิกจ่าย</div>
          </div>
          <div className="rcv-sign-box">
            <div className="rcv-sign-line" />
            <div className="rcv-sign-label">( ลงชื่อ ) ผู้อนุมัติ</div>
          </div>
        </div>
      </div>
    </div>
  );
}
