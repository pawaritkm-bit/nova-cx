"use client";

import { DOC_TYPE_LABELS } from "@/lib/accounting/doc-format";
import { lineTotal, type SalesDocument } from "@/lib/accounting/sales-documents";
import { bahtText } from "@/lib/accounting/baht-text";
import { formatMoney } from "@/lib/accounting/calc";

/** ISO → ไทย วว/ดด/ปปปป (พ.ศ.) — คืน "—" ถ้าไม่มีค่า */
function formatDateThai(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso;
}

const STATUS_LABELS: Record<SalesDocument["status"], string> = {
  draft: "ร่าง (ยังไม่ออกเลขที่)",
  issued: "ออกเอกสารแล้ว",
  void: "ยกเลิกแล้ว",
};

/**
 * เอกสารพิมพ์ ใบเสนอราคา/ใบสั่งซื้อ/ใบวางบิล — server component โหลดข้อมูลมาให้ครบแล้ว
 *   (ต่างจาก receipt-cert/wht-cert ที่แก้ในฟอร์มพิมพ์ได้ — เอกสารนี้แสดงข้อมูลที่บันทึกไว้แล้วล้วน ๆ
 *   เพราะเป็นเอกสารที่ "ออกเลขที่แล้ว/มีสถานะจริง" ไม่ใช่ฟอร์มกรอกอิสระแบบ print-only)
 *
 * ★ หัวเรื่องเปลี่ยนตาม document_type (K7 DoD)
 * ★ ยอด/รายการที่แสดง = สำเนา ณ เวลาบันทึก (sales_document_lines) — ไม่ join สดกับบิลต้นทาง/สินค้าอีก (0.14)
 */
export default function SalesDocumentPrintDoc({
  document: doc,
  issuerName,
  issuerTaxId,
  issuerAddress,
  backHref,
}: {
  document: SalesDocument;
  /** ผู้ออกเอกสาร = ลูกค้าของสำนักงาน (NOVA-CX customer) เสมอทั้ง 3 ประเภท */
  issuerName: string;
  issuerTaxId: string;
  issuerAddress: string;
  backHref: string;
}) {
  const total = lineTotal(doc.lines);
  const totalAmount = doc.lines.reduce((s, l) => s + l.amount, 0);
  const totalVat = doc.lines.reduce((s, l) => s + l.vatAmount, 0);
  const totalText = bahtText(total);
  const counterpartyLabel = doc.documentType === "purchase_order" ? "ผู้ขาย/ซัพพลายเออร์" : "ลูกค้า";

  return (
    <div className="sd-shell">
      <div className="sd-toolbar no-print">
        <a href={backHref} className="sd-btn sd-btn-ghost">
          ← กลับ
        </a>
        <span className="sd-toolbar-hint">เอกสารนี้เป็นข้อมูลที่บันทึกไว้แล้ว — พิมพ์/บันทึก PDF ได้ทันที</span>
        <button type="button" className="sd-btn sd-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
      </div>

      <div className="sd-page">
        <div className="sd-topmeta">
          <div className="sd-meta-item">
            <span className="sd-label">วันที่</span>
            <span className="sd-value">{formatDateThai(doc.docDate)}</span>
          </div>
          <div className="sd-meta-item">
            <span className="sd-label">เลขที่</span>
            <span className="sd-value sd-docno">{doc.docNo || "—"}</span>
          </div>
          {doc.documentType === "quotation" && doc.validUntil ? (
            <div className="sd-meta-item">
              <span className="sd-label">ยืนราคาถึง</span>
              <span className="sd-value">{formatDateThai(doc.validUntil)}</span>
            </div>
          ) : null}
          <div className="sd-meta-item">
            <span className="sd-label">สถานะ</span>
            <span className="sd-value">{STATUS_LABELS[doc.status]}</span>
          </div>
        </div>

        <h1 className="sd-title">{DOC_TYPE_LABELS[doc.documentType]}</h1>

        <div className="sd-parties">
          <div className="sd-party">
            <div className="sd-party-title">ผู้ออกเอกสาร</div>
            <div className="sd-party-name">{issuerName || "—"}</div>
            <div className="sd-party-sub">เลขผู้เสียภาษี: {issuerTaxId || "—"}</div>
            {issuerAddress ? <div className="sd-party-sub">{issuerAddress}</div> : null}
          </div>
          <div className="sd-party">
            <div className="sd-party-title">{counterpartyLabel}</div>
            <div className="sd-party-name">{doc.counterpartyName || "—"}</div>
            <div className="sd-party-sub">เลขผู้เสียภาษี: {doc.counterpartyTaxId || "—"}</div>
            {doc.counterpartyAddress ? <div className="sd-party-sub">{doc.counterpartyAddress}</div> : null}
          </div>
        </div>

        <table className="sd-table">
          <thead>
            <tr>
              <th className="sd-col-no">ลำดับ</th>
              <th>รายละเอียด</th>
              <th className="sd-col-qty">จำนวน</th>
              <th className="sd-col-unit">หน่วย</th>
              <th className="sd-col-amt">ราคา/หน่วย</th>
              <th className="sd-col-amt">จำนวนเงิน</th>
              <th className="sd-col-amt">VAT</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l, i) => (
              <tr key={l.id ?? i}>
                <td className="sd-col-no">{i + 1}</td>
                <td>{l.description || "—"}</td>
                <td className="sd-col-qty">{l.quantity}</td>
                <td className="sd-col-unit">{l.unit || "—"}</td>
                <td className="sd-col-amt">{formatMoney(l.unitPrice)}</td>
                <td className="sd-col-amt">{formatMoney(l.amount)}</td>
                <td className="sd-col-amt">{formatMoney(l.vatAmount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className="sd-total-label">รวมมูลค่าสินค้า/บริการ</td>
              <td className="sd-col-amt sd-total-amt">{formatMoney(totalAmount)}</td>
              <td className="sd-col-amt sd-total-amt">{formatMoney(totalVat)}</td>
            </tr>
            <tr>
              <td colSpan={6} className="sd-total-label">รวมทั้งสิ้น</td>
              <td className="sd-col-amt sd-total-amt">{formatMoney(total)}</td>
            </tr>
          </tfoot>
        </table>

        <p className="sd-amount-text">
          <span className="sd-label">จำนวนเงินรวม (ตัวอักษร)</span>
          <span className="sd-amount-words">({totalText})</span>
        </p>

        {doc.notes ? (
          <p className="sd-notes">
            <span className="sd-label">หมายเหตุ</span> {doc.notes}
          </p>
        ) : null}

        <div className="sd-sign">
          <div className="sd-sign-box">
            <div className="sd-sign-line" />
            <div className="sd-sign-label">( ลงชื่อ ) ผู้จัดทำ</div>
          </div>
          <div className="sd-sign-box">
            <div className="sd-sign-line" />
            <div className="sd-sign-label">( ลงชื่อ ) ผู้อนุมัติ/ผู้รับเอกสาร</div>
          </div>
        </div>
      </div>
    </div>
  );
}
