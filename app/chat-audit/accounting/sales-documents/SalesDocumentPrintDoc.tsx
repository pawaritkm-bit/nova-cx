"use client";

import { DOC_TYPE_LABELS } from "@/lib/accounting/doc-format";
import { lineTotal, type SalesDocument } from "@/lib/accounting/sales-documents";
import { bahtText } from "@/lib/accounting/baht-text";
import { formatMoney } from "@/lib/accounting/calc";

/** ISO → ไทย วว/ดด/ปปปป (ค.ศ. ตามฟอร์มตัวอย่าง) — คืน "—" ถ้าไม่มีค่า */
function formatDateForm(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** ป้ายช่องเซ็นตามชนิดเอกสาร (ซ้าย = ฝ่ายผู้รับ · ขวา = ฝ่ายผู้ออก) */
const SIGN_LABELS: Record<SalesDocument["documentType"], { left: string; right: string }> = {
  quotation: { left: "ผู้รับใบเสนอราคา", right: "ผู้เสนอราคา" },
  purchase_order: { left: "ผู้รับใบสั่งซื้อ", right: "ผู้สั่งซื้อ" },
  billing_note: { left: "ผู้รับวางบิล", right: "ผู้วางบิล" },
};

/**
 * เอกสารพิมพ์ ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล — ★ 2026-09-02 ผู้ใช้ส่งฟอร์มตัวอย่าง (ใบวางบิล PAMEE):
 *   "ก็อปฟอร์มนี้เข้าระบบ" — โครงตามตัวอย่าง: หัวซ้าย=ผู้ออก (ชื่อ/ที่อยู่/เลขภาษี/โทร) ·
 *   หัวขวา=ชื่อเอกสารใหญ่ + ต้นฉบับ + เลขที่/วันที่ · แถบสามเหลี่ยมม่วงมุมขวาบน (เลขหน้า) ·
 *   บล็อกลูกค้า · ตาราง #/รายละเอียด/จำนวน/ราคาต่อหน่วย/ส่วนลด/ภาษี/หัก ณ ที่จ่าย/มูลค่า ·
 *   สรุปยอดขวา + ยอดตัวอักษรซ้าย · หักภาษี ณ ที่จ่าย/ยอดจ่าย · หมายเหตุ ·
 *   ท้าย: ในนามสองฝั่ง + ช่องเซ็น ผู้รับ/ผู้วาง + วันที่
 * ★ ยอด/รายการ = สำเนา ณ เวลาบันทึก (sales_document_lines) — ไม่ join สดกับบิลต้นทาง (0.14)
 */
export default function SalesDocumentPrintDoc({
  document: doc,
  issuerName,
  issuerTaxId,
  issuerAddress,
  issuerPhone = "",
  backHref,
}: {
  document: SalesDocument;
  /** ผู้ออกเอกสาร = ลูกค้าของสำนักงาน (NOVA-CX customer) เสมอทั้ง 3 ประเภท */
  issuerName: string;
  issuerTaxId: string;
  issuerAddress: string;
  issuerPhone?: string;
  backHref: string;
}) {
  const total = lineTotal(doc.lines);
  const totalAmount = doc.lines.reduce((s, l) => s + l.amount, 0);
  const totalVat = doc.lines.reduce((s, l) => s + l.vatAmount, 0);
  const vatBase = doc.lines.reduce((s, l) => s + (l.vatAmount > 0 ? l.amount : 0), 0);
  const exemptBase = doc.lines.reduce((s, l) => s + (l.vatAmount > 0 ? 0 : l.amount), 0);
  const totalText = bahtText(total);
  const counterpartyLabel = doc.documentType === "purchase_order" ? "ผู้ขาย/ซัพพลายเออร์" : "ลูกค้า";
  const sign = SIGN_LABELS[doc.documentType];
  const initial = (issuerName || "—").replace(/^(บริษัท|บจก\.?|หจก\.?|ห้างหุ้นส่วนจำกัด)\s*/i, "").trim().slice(0, 2) || "—";

  return (
    <div className="sd-shell">
      <div className="sd-toolbar no-print">
        <a href={backHref} className="sd-btn sd-btn-ghost">
          ← กลับ
        </a>
        <span className="sd-toolbar-hint">
          เอกสารนี้เป็นข้อมูลที่บันทึกไว้แล้ว — พิมพ์/บันทึก PDF ได้ทันที
          {doc.status === "void" ? " · ⚠ เอกสารนี้ถูกยกเลิกแล้ว" : doc.status === "draft" ? " · ร่าง (ยังไม่ออกเลขที่)" : ""}
        </span>
        <button type="button" className="sd-btn sd-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
      </div>

      <div className="sd-page sd-form">
        {/* แถบสามเหลี่ยมมุมขวาบน (เลขหน้า) — ตามฟอร์มตัวอย่าง */}
        <div className="sd-corner" aria-hidden="true"><span>1</span></div>
        {doc.status === "void" ? <div className="sd-void-stamp">ยกเลิก</div> : null}

        {/* ---- หัวเอกสาร: ซ้าย=ผู้ออก · ขวา=ชื่อเอกสาร + meta ---- */}
        <div className="sd-head">
          <div className="sd-head-left">
            <div className="sd-logo" aria-hidden="true">{initial}</div>
            <div className="sd-issuer">
              <div className="sd-issuer-name">{issuerName || "—"}</div>
              {issuerAddress ? <div>{issuerAddress}</div> : null}
              <div>เลขประจำตัวผู้เสียภาษี {issuerTaxId || "—"}</div>
              {issuerPhone ? <div>โทร. {issuerPhone}</div> : null}
            </div>
          </div>
          <div className="sd-head-right">
            <div className="sd-doc-title">{DOC_TYPE_LABELS[doc.documentType]}</div>
            <div className="sd-doc-sub">ต้นฉบับ</div>
            <div className="sd-meta">
              <div><span className="sd-meta-k">เลขที่</span><span>{doc.docNo || "— (ร่าง)"}</span></div>
              <div><span className="sd-meta-k">วันที่</span><span>{formatDateForm(doc.docDate)}</span></div>
              {doc.documentType === "quotation" && doc.validUntil ? (
                <div><span className="sd-meta-k">ยืนราคาถึง</span><span>{formatDateForm(doc.validUntil)}</span></div>
              ) : null}
            </div>
          </div>
        </div>

        {/* ---- ลูกค้า ---- */}
        <div className="sd-cust">
          <div className="sd-cust-title">{counterpartyLabel}</div>
          <div className="sd-cust-name">{doc.counterpartyName || "—"}</div>
          {doc.counterpartyAddress ? <div>{doc.counterpartyAddress}</div> : null}
          {doc.counterpartyTaxId ? <div>เลขประจำตัวผู้เสียภาษี {doc.counterpartyTaxId}</div> : null}
        </div>

        {/* ---- ตารางรายการ (คอลัมน์ตามฟอร์มตัวอย่าง) ---- */}
        <table className="sd-table sd-form-table">
          <thead>
            <tr>
              <th className="sd-col-no">#</th>
              <th>รายละเอียด</th>
              <th className="sd-col-qty">จำนวน</th>
              <th className="sd-col-amt">ราคาต่อหน่วย</th>
              <th className="sd-col-amt">ส่วนลด</th>
              <th className="sd-col-qty">ภาษี</th>
              <th className="sd-col-qty">หัก ณ ที่จ่าย</th>
              <th className="sd-col-amt">มูลค่า</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l, i) => (
              <tr key={l.id ?? i}>
                <td className="sd-col-no">{i + 1}</td>
                <td>
                  {l.description || "—"}
                  {l.unit ? <span className="sd-unit"> ({l.unit})</span> : null}
                </td>
                <td className="sd-col-qty">{l.quantity}</td>
                <td className="sd-col-amt">{formatMoney(l.unitPrice)}</td>
                <td className="sd-col-amt">—</td>
                <td className="sd-col-qty">{l.vatAmount > 0 ? "7 %" : "—"}</td>
                <td className="sd-col-qty">ไม่หัก</td>
                <td className="sd-col-amt">{formatMoney(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ---- สรุปยอด: ซ้าย=ตัวอักษร · ขวา=บรรทัดยอด (ตามฟอร์มตัวอย่าง) ---- */}
        <div className="sd-sum">
          <div className="sd-sum-left">({totalText})</div>
          <div className="sd-sum-right">
            <div><span>รวมเป็นเงิน</span><b>{formatMoney(totalAmount)} บาท</b></div>
            <div><span>มูลค่าที่ไม่มี/ยกเว้นภาษี</span><b>{formatMoney(exemptBase)} บาท</b></div>
            <div><span>มูลค่าที่คำนวณภาษี</span><b>{formatMoney(vatBase)} บาท</b></div>
            <div><span>ภาษีมูลค่าเพิ่ม</span><b>{formatMoney(totalVat)} บาท</b></div>
            <div className="sd-sum-grand"><span>จำนวนเงินรวมทั้งสิ้น</span><b>{formatMoney(total)} บาท</b></div>
            <div className="sd-sum-pay">
              <div><span>หักภาษี ณ ที่จ่ายทั้งสิ้น</span><b>0.00 บาท</b></div>
              <div><span>ยอดจ่าย</span><b>{formatMoney(total)} บาท</b></div>
            </div>
          </div>
        </div>

        {doc.notes ? (
          <div className="sd-notes-block">
            <div className="sd-cust-title">หมายเหตุ</div>
            <div>{doc.notes}</div>
          </div>
        ) : null}

        {/* ---- ท้ายเอกสาร: ในนามสองฝั่ง + ช่องเซ็น (ตามฟอร์มตัวอย่าง) ---- */}
        <div className="sd-foot">
          <div className="sd-foot-side">
            <div className="sd-foot-inname">ในนาม {doc.counterpartyName || "—"}</div>
            <div className="sd-foot-signs">
              <div className="sd-sign-box"><div className="sd-sign-line" /><div className="sd-sign-label">{sign.left}</div></div>
              <div className="sd-sign-box"><div className="sd-sign-line" /><div className="sd-sign-label">วันที่</div></div>
            </div>
          </div>
          <div className="sd-foot-side sd-foot-right">
            <div className="sd-foot-inname">ในนาม {issuerName || "—"}</div>
            <div className="sd-foot-signs">
              <div className="sd-sign-box"><div className="sd-sign-line" /><div className="sd-sign-label">{sign.right}</div></div>
              <div className="sd-sign-box"><div className="sd-sign-line" /><div className="sd-sign-label">วันที่</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
