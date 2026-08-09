"use client";

import { useMemo, useState } from "react";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";
import { bahtText } from "@/lib/accounting/baht-text";
import { WHT_INCOME_TYPE_OPTIONS, type WhtCertLine } from "@/lib/accounting/wht-cert";

/** แถวในฟอร์ม — เก็บตัวเลขเป็น string เพื่อให้พิมพ์/แก้ได้ลื่น (parse ตอนคำนวณ) */
type Row = {
  key: number;
  date: string;
  description: string;
  amount: string;
  whtRate: string;
  whtAmount: string;
};

/**
 * หนังสือรับรองหัก ณ ที่จ่าย — เอกสารที่ "แก้ไขช่องได้" + พิมพ์/บันทึก PDF ผ่านเบราว์เซอร์
 *
 * โครง (mirror ReceiptCertDoc):
 *   หัว: ชื่อเรื่อง → ผู้จ่ายเงิน/ผู้มีหน้าที่หัก (ลูกค้า) → เลขภาษี/ที่อยู่
 *   มุมขวาบน: เลขที่ / วันที่ (ช่องกรอกอิสระ ไม่ persist ไม่ auto-number)
 *   ผู้ถูกหักภาษี (ผู้รับเงิน) = counterparty ของบิล
 *   checkbox "บุคคลธรรมดา (ภ.ง.ด.3)" / "นิติบุคคล (ภ.ง.ด.53)" — prefill จาก bill_entries.wht_form
 *     แก้ในฟอร์มพิมพ์ได้ ไม่ persist กลับ
 *   dropdown "ประเภทเงินได้พึงประเมิน" (WHT_INCOME_TYPE_OPTIONS) — ไม่ persist
 *   ตารางบรรทัด WHT: วันที่จ่าย / เงินได้ที่จ่าย / อัตรา (%) / ภาษีที่หักไว้
 *   รวมทั้งสิ้น + ตัวอักษร (bahtText ของยอดภาษีที่หัก)
 *   ช่องลงชื่อผู้จ่ายเงิน
 *
 * ★ ทุกช่องเป็น input/select (แก้ก่อนพิมพ์ได้) · ปุ่ม/เครื่องมือซ่อนตอนพิมพ์ (.no-print)
 * ★ ไม่ยิง network — เอกสารทำงานฝั่ง client ล้วน (print-only ไม่บันทึก DB)
 * ★ [⚠️ FLAG] รูปแบบเอกสารเป็นการจำลองแบบง่าย ไม่ใช่ฟอร์มราชการ (ภ.ง.ด.1ก/50 ทวิ) เป๊ะ 100%
 */
export default function WhtCertDoc({
  payerName,
  payerTaxId,
  payerAddress,
  payeeName,
  payeeTaxId,
  docDate,
  whtForm,
  items,
  backHref,
}: {
  /** ผู้จ่ายเงิน/ผู้มีหน้าที่หักภาษี = ลูกค้าของสำนักงาน (ไม่ใช่ Finovas) */
  payerName: string;
  payerTaxId: string;
  payerAddress: string;
  /** ผู้ถูกหักภาษี/ผู้รับเงิน = คู่ค้าของบิล (prefill จาก counterparty ของบิล ถ้ามี) */
  payeeName: string;
  payeeTaxId: string;
  /** วันที่เอกสาร (มุมขวาบน) dd/mm/พ.ศ. */
  docDate: string;
  /** prefill checkbox — null = ยังไม่ระบุ (ไม่ติ๊กช่องใดเลย) */
  whtForm: "pnd3" | "pnd53" | null;
  items: WhtCertLine[];
  backHref: string;
}) {
  // ---- หัวเอกสาร / meta ----
  const [docNo, setDocNo] = useState("");
  const [date, setDate] = useState(docDate);

  // ---- ผู้จ่ายเงิน (ลูกค้า) ----
  const [payer, setPayer] = useState(payerName);
  const [payerTax, setPayerTax] = useState(payerTaxId);
  const [payerAddr, setPayerAddr] = useState(payerAddress);

  // ---- ผู้ถูกหักภาษี (ผู้รับเงิน) ----
  const [payee, setPayee] = useState(payeeName);
  const [payeeTax, setPayeeTax] = useState(payeeTaxId);

  // ---- บุคคลธรรมดา/นิติบุคคล (แก้ในฟอร์มพิมพ์ได้ ไม่ persist) ----
  const [form, setForm] = useState<"pnd3" | "pnd53" | null>(whtForm);

  // ---- ประเภทเงินได้พึงประเมิน (dropdown ไม่ persist) ----
  const [incomeType, setIncomeType] = useState(WHT_INCOME_TYPE_OPTIONS[0]?.value ?? "");

  // ---- ตารางรายการ WHT ----
  const [rows, setRows] = useState<Row[]>(() =>
    (items.length > 0
      ? items
      : [{ date: "", description: "", amount: 0, whtRate: 0, whtAmount: 0 }]
    ).map((it, i) => ({
      key: i,
      date: it.date,
      description: it.description,
      amount: it.amount ? String(it.amount) : "",
      whtRate: it.whtRate ? String(it.whtRate) : "",
      whtAmount: it.whtAmount ? String(it.whtAmount) : "",
    }))
  );
  const [nextKey, setNextKey] = useState(rows.length);

  const totalAmount = useMemo(
    () => rows.reduce((sum, r) => sum + parseAmountInput(r.amount), 0),
    [rows]
  );
  const totalWht = useMemo(
    () => rows.reduce((sum, r) => sum + parseAmountInput(r.whtAmount), 0),
    [rows]
  );
  const totalWhtText = useMemo(() => bahtText(totalWht), [totalWht]);

  function updateRow(key: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [
      ...prev,
      { key: nextKey, date: "", description: "", amount: "", whtRate: "", whtAmount: "" },
    ]);
    setNextKey((k) => k + 1);
  }
  function removeRow(key: number) {
    // กันลบจนไม่เหลือแถว (อย่างน้อย 1 แถว)
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.key !== key)));
  }

  return (
    <div className="whtc-shell">
      {/* ---- แถบเครื่องมือ (ซ่อนตอนพิมพ์) ---- */}
      <div className="whtc-toolbar no-print">
        <a href={backHref} className="whtc-btn whtc-btn-ghost">
          ← กลับ
        </a>
        <span className="whtc-toolbar-hint">
          แก้ข้อความในเอกสารได้ทุกช่อง แล้วกด “พิมพ์ / บันทึก PDF”
        </span>
        <button type="button" className="whtc-btn whtc-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
      </div>

      {/* ================= ตัวเอกสาร (A4) ================= */}
      <div className="whtc-page">
        {/* วันที่ / เลขที่ (มุมขวาบน — วันที่ขึ้นก่อน เลขที่อยู่ใต้) */}
        <div className="whtc-topmeta">
          <div className="whtc-meta-item">
            <span className="whtc-label">วันที่</span>
            <input
              className="whtc-in whtc-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              placeholder="วว/ดด/ปปปป"
              aria-label="วันที่"
            />
          </div>
          <div className="whtc-meta-item">
            <span className="whtc-label">เลขที่</span>
            <input
              className="whtc-in whtc-docno"
              value={docNo}
              onChange={(e) => setDocNo(e.target.value)}
              placeholder="เลขที่เอกสาร"
              aria-label="เลขที่เอกสาร"
            />
          </div>
        </div>

        <h1 className="whtc-title">หนังสือรับรองการหักภาษี ณ ที่จ่าย</h1>

        {/* ---- ผู้จ่ายเงิน (ลูกค้า) ---- */}
        <div className="whtc-party">
          <div className="whtc-party-row">
            <span className="whtc-label">ผู้มีหน้าที่หักภาษี ณ ที่จ่าย (ผู้จ่ายเงิน)</span>
            <input
              className="whtc-in whtc-partyname"
              value={payer}
              onChange={(e) => setPayer(e.target.value)}
              placeholder="ชื่อผู้จ่ายเงิน"
              aria-label="ชื่อผู้จ่ายเงิน"
            />
          </div>
          <div className="whtc-party-sub">
            <span className="whtc-label">เลขประจำตัวผู้เสียภาษีอากร</span>
            <input
              className="whtc-in whtc-taxid"
              value={payerTax}
              onChange={(e) => setPayerTax(e.target.value)}
              placeholder="—"
              aria-label="เลขประจำตัวผู้เสียภาษีอากรผู้จ่ายเงิน"
            />
          </div>
          <div className="whtc-party-sub">
            <span className="whtc-label">ที่อยู่</span>
            <input
              className="whtc-in whtc-address"
              value={payerAddr}
              onChange={(e) => setPayerAddr(e.target.value)}
              placeholder="—"
              aria-label="ที่อยู่ผู้จ่ายเงิน"
            />
          </div>
        </div>

        {/* ---- ผู้ถูกหักภาษี (ผู้รับเงิน) ---- */}
        <div className="whtc-party">
          <div className="whtc-party-row">
            <span className="whtc-label">ผู้ถูกหักภาษี ณ ที่จ่าย (ผู้รับเงิน)</span>
            <input
              className="whtc-in whtc-partyname"
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              placeholder="ชื่อผู้รับเงิน"
              aria-label="ชื่อผู้รับเงิน"
            />
          </div>
          <div className="whtc-party-sub">
            <span className="whtc-label">เลขประจำตัวผู้เสียภาษีอากร</span>
            <input
              className="whtc-in whtc-taxid"
              value={payeeTax}
              onChange={(e) => setPayeeTax(e.target.value)}
              placeholder="—"
              aria-label="เลขประจำตัวผู้เสียภาษีอากรผู้รับเงิน"
            />
          </div>
        </div>

        {/* ---- ประเภทผู้ถูกหักภาษี + ประเภทเงินได้ ---- */}
        <div className="whtc-metarow">
          <div className="whtc-checkgroup" role="group" aria-label="ประเภทผู้ถูกหักภาษี">
            <label className="whtc-checklabel">
              <input
                type="checkbox"
                checked={form === "pnd3"}
                onChange={() => setForm((prev) => (prev === "pnd3" ? null : "pnd3"))}
              />
              บุคคลธรรมดา (ภ.ง.ด.3)
            </label>
            <label className="whtc-checklabel">
              <input
                type="checkbox"
                checked={form === "pnd53"}
                onChange={() => setForm((prev) => (prev === "pnd53" ? null : "pnd53"))}
              />
              นิติบุคคล (ภ.ง.ด.53)
            </label>
          </div>
          <div className="whtc-incometype">
            <span className="whtc-label">ประเภทเงินได้พึงประเมิน</span>
            <select
              className="whtc-in whtc-select"
              value={incomeType}
              onChange={(e) => setIncomeType(e.target.value)}
              aria-label="ประเภทเงินได้พึงประเมิน"
            >
              {WHT_INCOME_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* ตารางรายการ WHT */}
        <table className="whtc-table">
          <thead>
            <tr>
              <th className="whtc-col-date">วันที่จ่าย</th>
              <th className="whtc-col-desc">รายละเอียด</th>
              <th className="whtc-col-amt">เงินได้ที่จ่าย</th>
              <th className="whtc-col-rate">อัตรา (%)</th>
              <th className="whtc-col-amt">ภาษีที่หักไว้</th>
              <th className="whtc-col-del no-print" aria-label="ลบ" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.key}>
                <td className="whtc-col-date">
                  <input
                    className="whtc-in whtc-cell whtc-cell-date"
                    value={r.date}
                    onChange={(e) => updateRow(r.key, { date: e.target.value })}
                    placeholder="วว/ดด/ปปปป"
                    aria-label={`วันที่จ่ายรายการที่ ${idx + 1}`}
                  />
                </td>
                <td>
                  <input
                    className="whtc-in whtc-cell"
                    value={r.description}
                    onChange={(e) => updateRow(r.key, { description: e.target.value })}
                    placeholder="รายละเอียด"
                    aria-label={`รายการที่ ${idx + 1}`}
                  />
                </td>
                <td className="whtc-col-amt">
                  <input
                    className="whtc-in whtc-cell whtc-cell-amt"
                    value={r.amount}
                    onChange={(e) => updateRow(r.key, { amount: e.target.value })}
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label={`เงินได้ที่จ่ายรายการที่ ${idx + 1}`}
                  />
                </td>
                <td className="whtc-col-rate">
                  <input
                    className="whtc-in whtc-cell whtc-cell-rate"
                    value={r.whtRate}
                    onChange={(e) => updateRow(r.key, { whtRate: e.target.value })}
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={`อัตราภาษีรายการที่ ${idx + 1}`}
                  />
                </td>
                <td className="whtc-col-amt">
                  <input
                    className="whtc-in whtc-cell whtc-cell-amt"
                    value={r.whtAmount}
                    onChange={(e) => updateRow(r.key, { whtAmount: e.target.value })}
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label={`ภาษีที่หักไว้รายการที่ ${idx + 1}`}
                  />
                </td>
                <td className="whtc-col-del no-print">
                  <button
                    type="button"
                    className="whtc-row-del"
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
              <td colSpan={2} className="whtc-total-label">รวมทั้งสิ้น</td>
              <td className="whtc-col-amt whtc-total-amt">{formatMoney(totalAmount)}</td>
              <td className="whtc-col-rate" />
              <td className="whtc-col-amt whtc-total-amt">{formatMoney(totalWht)}</td>
              <td className="no-print" />
            </tr>
          </tfoot>
        </table>

        {/* ปุ่มเพิ่มแถว (ซ่อนตอนพิมพ์) */}
        <div className="no-print whtc-addrow-wrap">
          <button type="button" className="whtc-btn whtc-btn-ghost" onClick={addRow}>
            ＋ เพิ่มรายการ
          </button>
        </div>

        {/* ยอดภาษีที่หักไว้เป็นตัวอักษร */}
        <p className="whtc-amount-text">
          <span className="whtc-label">ภาษีที่หักไว้ทั้งสิ้น (ตัวอักษร)</span>
          <span className="whtc-amount-words">({totalWhtText})</span>
        </p>

        {/* ช่องลงชื่อ */}
        <div className="whtc-sign">
          <div className="whtc-sign-box">
            <div className="whtc-sign-line" />
            <div className="whtc-sign-label">( ลงชื่อ ) ผู้จ่ายเงิน</div>
          </div>
        </div>
      </div>
    </div>
  );
}
