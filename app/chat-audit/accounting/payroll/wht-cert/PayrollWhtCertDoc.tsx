"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/accounting/calc";
import { bahtText } from "@/lib/accounting/baht-text";
import type { PayrollWhtCertData } from "@/lib/accounting/payroll-wht-cert";
import { revealIdCardAction } from "../../payroll-employees/actions";

const MONTH_LABELS = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/**
 * หนังสือรับรองหัก ณ ที่จ่ายพนักงาน (50 ทวิ) — เอกสารที่ "แก้ไขช่องได้" + พิมพ์/บันทึก PDF ผ่านเบราว์เซอร์
 *   (mirror CSS/สไตล์ของ WhtCertDoc เดิม — เฟส 3 ส่วน I) — เฟส 9b กลุ่ม BD
 *
 * ★★★ 0.4 — ยอด YTD นายจ้างเดิมแสดงเป็นบล็อกแยกต่างหากชัดเจน "ไม่รวมในยอดข้างต้น" เสมอ ไม่มีการบวกรวมยอด
 *   ทั้งสองนายจ้างเป็นตัวเลขเดียวในหน้าจอนี้เลย (การ reconcile เป็นหน้าที่พนักงานตอนยื่น ภ.ง.ด.90/91 เอง)
 * ★ 0.12 PDPA: เลขบัตรประชาชนพนักงานมาสก์มาก่อนเสมอ (props) — ต้องกดปุ่ม "เผยเลขเต็ม" (reuse
 *   revealIdCardAction เดิมจากหน้าทะเบียนพนักงาน, guard สโคปเดิมทุกประการ) ก่อนพิมพ์จริงถ้าต้องใช้เลขเต็ม
 * ★ ไม่ยิง network นอกจากปุ่มเผยเลขเต็ม — เอกสารพิมพ์ล้วน ไม่บันทึก DB / ไม่ auto-number
 */
export default function PayrollWhtCertDoc({
  payerName,
  payerTaxId,
  payerAddress,
  employeeId,
  customerId,
  employeeFullName,
  employeeIdCardNoMasked,
  certData,
  backHref,
}: {
  payerName: string;
  payerTaxId: string;
  payerAddress: string;
  employeeId: string;
  customerId: string;
  employeeFullName: string;
  employeeIdCardNoMasked: string | null;
  certData: PayrollWhtCertData;
  backHref: string;
}) {
  const [docNo, setDocNo] = useState("");
  const [date, setDate] = useState("");

  const [payer, setPayer] = useState(payerName);
  const [payerTax, setPayerTax] = useState(payerTaxId);
  const [payerAddr, setPayerAddr] = useState(payerAddress);

  const [payeeName, setPayeeName] = useState(employeeFullName);
  const [payeeIdCard, setPayeeIdCard] = useState(employeeIdCardNoMasked ?? "");
  const [revealing, setRevealing] = useState(false);
  const [revealErr, setRevealErr] = useState<string | null>(null);

  const reveal = async () => {
    setRevealErr(null);
    setRevealing(true);
    try {
      const res = await revealIdCardAction(employeeId, customerId);
      if (res.ok) setPayeeIdCard(res.idCardNo ?? "");
      else setRevealErr(res.message);
    } finally {
      setRevealing(false);
    }
  };

  const byMonth = new Map(certData.monthlyBreakdown.map((r) => [r.payPeriodMonth, r]));

  return (
    <div>
      {/* ---- แถบเครื่องมือ (ซ่อนตอนพิมพ์) ---- */}
      <div className="whtc-toolbar no-print">
        <a href={backHref} className="whtc-btn whtc-btn-ghost">← กลับ</a>
        <span className="whtc-toolbar-hint">แก้ข้อความในเอกสารได้ทุกช่อง แล้วกด “พิมพ์ / บันทึก PDF”</span>
        <button type="button" className="whtc-btn whtc-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
      </div>

      <div className="whtc-page">
        <div className="whtc-topmeta">
          <div className="whtc-meta-item">
            <span className="whtc-label">วันที่</span>
            <input className="whtc-in whtc-date" value={date} onChange={(e) => setDate(e.target.value)} placeholder="วว/ดด/ปปปป" aria-label="วันที่" />
          </div>
          <div className="whtc-meta-item">
            <span className="whtc-label">เลขที่</span>
            <input className="whtc-in whtc-docno" value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="เลขที่เอกสาร" aria-label="เลขที่เอกสาร" />
          </div>
        </div>

        <h1 className="whtc-title">หนังสือรับรองการหักภาษี ณ ที่จ่าย (พนักงาน) — ปีภาษี {certData.taxYear}</h1>

        <div className="whtc-party">
          <div className="whtc-party-row">
            <span className="whtc-label">ผู้มีหน้าที่หักภาษี ณ ที่จ่าย (นายจ้าง)</span>
            <input className="whtc-in whtc-partyname" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="ชื่อนายจ้าง" aria-label="ชื่อนายจ้าง" />
          </div>
          <div className="whtc-party-sub">
            <span className="whtc-label">เลขประจำตัวผู้เสียภาษีอากร</span>
            <input className="whtc-in whtc-taxid" value={payerTax} onChange={(e) => setPayerTax(e.target.value)} placeholder="—" aria-label="เลขประจำตัวผู้เสียภาษีอากรนายจ้าง" />
          </div>
          <div className="whtc-party-sub">
            <span className="whtc-label">ที่อยู่</span>
            <input className="whtc-in whtc-address" value={payerAddr} onChange={(e) => setPayerAddr(e.target.value)} placeholder="—" aria-label="ที่อยู่นายจ้าง" />
          </div>
        </div>

        <div className="whtc-party">
          <div className="whtc-party-row">
            <span className="whtc-label">ผู้ถูกหักภาษี ณ ที่จ่าย (พนักงาน)</span>
            <input className="whtc-in whtc-partyname" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="ชื่อพนักงาน" aria-label="ชื่อพนักงาน" />
          </div>
          <div className="whtc-party-sub">
            <span className="whtc-label">เลขประจำตัวประชาชน/ผู้เสียภาษีอากร</span>
            <input className="whtc-in whtc-taxid" value={payeeIdCard} onChange={(e) => setPayeeIdCard(e.target.value)} placeholder="—" aria-label="เลขบัตรประชาชนพนักงาน" />
            <button type="button" className="whtc-btn whtc-btn-ghost no-print" disabled={revealing} onClick={reveal} style={{ marginLeft: 6 }}>
              เผยเลขเต็ม
            </button>
          </div>
          {revealErr ? <div className="no-print" style={{ color: "#b91c1c", fontSize: 13 }}>{revealErr}</div> : null}
        </div>

        <table className="whtc-table">
          <thead>
            <tr>
              <th className="whtc-col-date">เดือน</th>
              <th className="whtc-col-amt">เงินได้ที่จ่าย</th>
              <th className="whtc-col-amt">ภาษีที่หักไว้</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
              const row = byMonth.get(m);
              return (
                <tr key={m}>
                  <td className="whtc-col-date">{MONTH_LABELS[m]}</td>
                  <td className="whtc-col-amt">{row ? formatMoney(row.income) : "—"}</td>
                  <td className="whtc-col-amt">{row ? formatMoney(row.pitWithheld) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="whtc-total-label">รวมทั้งสิ้น (นายจ้างปัจจุบัน)</td>
              <td className="whtc-col-amt whtc-total-amt">{formatMoney(certData.currentEmployerTotalIncome)}</td>
              <td className="whtc-col-amt whtc-total-amt">{formatMoney(certData.currentEmployerTotalPitWithheld)}</td>
            </tr>
          </tfoot>
        </table>

        <p className="whtc-amount-text">
          <span className="whtc-label">ภาษีที่หักไว้ทั้งสิ้น (นายจ้างปัจจุบัน, ตัวอักษร)</span>
          <span className="whtc-amount-words">({bahtText(certData.currentEmployerTotalPitWithheld)})</span>
        </p>

        {certData.priorEmployer ? (
          <div className="whtc-party" style={{ marginTop: 16 }}>
            <div className="whtc-party-row">
              <span className="whtc-label">
                ยอดยกมาจากนายจ้างเดิม (อ้างอิงเท่านั้น — ไม่รวมในยอดข้างต้น){certData.priorEmployer.note ? ` — ${certData.priorEmployer.note}` : ""}
              </span>
            </div>
            <div className="whtc-party-sub">
              <span className="whtc-label">เงินได้ยกมา</span>
              <span>{certData.priorEmployer.gross !== null ? formatMoney(certData.priorEmployer.gross) : "—"}</span>
            </div>
            <div className="whtc-party-sub">
              <span className="whtc-label">ภาษีหัก ณ ที่จ่ายยกมา</span>
              <span>{certData.priorEmployer.pitWithheld !== null ? formatMoney(certData.priorEmployer.pitWithheld) : "—"}</span>
            </div>
            <div className="whtc-party-sub">
              <span className="whtc-label">ประกันสังคม (ลูกจ้าง) ยกมา</span>
              <span>{certData.priorEmployer.ssoEmployee !== null ? formatMoney(certData.priorEmployer.ssoEmployee) : "—"}</span>
            </div>
          </div>
        ) : null}

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
