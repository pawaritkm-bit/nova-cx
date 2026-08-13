"use client";

import { TAX_INVOICE_FORM_LABELS, taxInvoiceGrandTotal, taxInvoiceVatSummary, type TaxInvoice } from "@/lib/accounting/tax-invoice";
import { bahtText } from "@/lib/accounting/baht-text";
import { formatMoney } from "@/lib/accounting/calc";

/** ISO → ไทย วว/ดด/ปปปป (พ.ศ.) — คืน "—" ถ้าไม่มีค่า */
function formatDateThai(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso;
}

const STATUS_LABELS: Record<TaxInvoice["status"], string> = {
  issued: "ออกเอกสารแล้ว",
  void: "ยกเลิกแล้ว",
};

/**
 * เอกสารพิมพ์ใบกำกับภาษี (เต็มรูป/อย่างย่อ) — server component โหลดข้อมูลมาให้ครบแล้ว
 *   รายการที่แสดง = สำเนา ณ เวลาที่ออกเอกสาร (tax_invoice_lines) — ไม่ join สดกับบิลต้นทางอีก (mirror 0.14)
 *
 * ★ ผู้ขาย (ผู้ออกใบกำกับภาษี) = ข้อมูลลูกค้าของสำนักงาน (customers.business_name/tax_id/address)
 * ★ ผู้ซื้อ = buyer_name/buyer_tax_id/buyer_address ที่บันทึกไว้ตอนออกเอกสาร (ว่างได้ถ้าเป็นอย่างย่อ)
 */
export default function TaxInvoicePrintDoc({
  invoice,
  sellerName,
  sellerTaxId,
  sellerAddress,
  backHref,
}: {
  invoice: TaxInvoice;
  sellerName: string;
  sellerTaxId: string;
  sellerAddress: string;
  backHref: string;
}) {
  const total = taxInvoiceGrandTotal(invoice.lines);
  const vatSummary = taxInvoiceVatSummary(invoice.lines);
  const totalText = bahtText(total);
  const isAbbreviated = invoice.formType === "abbreviated";

  return (
    <div className="ti-shell">
      <div className="ti-toolbar no-print">
        <a href={backHref} className="ti-btn ti-btn-ghost">
          ← กลับ
        </a>
        <span className="ti-toolbar-hint">เอกสารนี้เป็นข้อมูลที่บันทึกไว้แล้ว — พิมพ์/บันทึก PDF ได้ทันที</span>
        <button type="button" className="ti-btn ti-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
      </div>

      <div className="ti-page">
        <div className="ti-topmeta">
          <div className="ti-meta-item">
            <span className="ti-label">วันที่</span>
            <span className="ti-value">{formatDateThai(invoice.docDate)}</span>
          </div>
          <div className="ti-meta-item">
            <span className="ti-label">เลขที่</span>
            <span className="ti-value ti-docno">{invoice.docNo}</span>
          </div>
          <div className="ti-meta-item">
            <span className="ti-label">สถานะ</span>
            <span className="ti-value">{STATUS_LABELS[invoice.status]}</span>
          </div>
        </div>

        <h1 className="ti-title">{TAX_INVOICE_FORM_LABELS[invoice.formType]}</h1>

        <div className="ti-parties">
          <div className="ti-party">
            <div className="ti-party-title">ผู้ขาย/ผู้ออกใบกำกับภาษี</div>
            <div className="ti-party-name">{sellerName || "—"}</div>
            <div className="ti-party-sub">เลขผู้เสียภาษี: {sellerTaxId || "—"}</div>
            {sellerAddress ? <div className="ti-party-sub">{sellerAddress}</div> : null}
            {invoice.sellerBranch ? <div className="ti-party-sub">สาขา: {invoice.sellerBranch}</div> : null}
          </div>
          <div className="ti-party">
            <div className="ti-party-title">ผู้ซื้อ</div>
            <div className="ti-party-name">{invoice.buyerName || (isAbbreviated ? "ลูกค้าทั่วไป" : "—")}</div>
            {invoice.buyerTaxId ? <div className="ti-party-sub">เลขผู้เสียภาษี: {invoice.buyerTaxId}</div> : null}
            {invoice.buyerAddress ? <div className="ti-party-sub">{invoice.buyerAddress}</div> : null}
            {invoice.buyerBranch ? <div className="ti-party-sub">สาขา: {invoice.buyerBranch}</div> : null}
          </div>
        </div>

        <table className="ti-table">
          <thead>
            <tr>
              <th className="ti-col-no">ลำดับ</th>
              <th>รายละเอียด</th>
              <th className="ti-col-qty">จำนวน</th>
              <th className="ti-col-unit">หน่วย</th>
              <th className="ti-col-amt">ราคา/หน่วย</th>
              <th className="ti-col-amt">จำนวนเงิน</th>
              <th className="ti-col-amt">VAT</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l, i) => (
              <tr key={l.id ?? i}>
                <td className="ti-col-no">{i + 1}</td>
                <td>{l.description || "—"}</td>
                <td className="ti-col-qty">{l.quantity}</td>
                <td className="ti-col-unit">{l.unit || "—"}</td>
                <td className="ti-col-amt">{formatMoney(l.unitPrice)}</td>
                <td className="ti-col-amt">{formatMoney(l.amount)}</td>
                <td className="ti-col-amt">{l.vatType === "novat" ? "—" : formatMoney(l.vatAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="ti-vat-summary">
          {vatSummary.baseExempt > 0 ? (
            <div className="ti-vat-row">
              <span>มูลค่าที่ยกเว้นภาษี</span>
              <span className="num">{formatMoney(vatSummary.baseExempt)}</span>
            </div>
          ) : null}
          <div className="ti-vat-row">
            <span>มูลค่าสินค้า/บริการ (ฐานภาษี)</span>
            <span className="num">{formatMoney(vatSummary.baseVat)}</span>
          </div>
          <div className="ti-vat-row">
            <span>ภาษีมูลค่าเพิ่ม</span>
            <span className="num">{formatMoney(vatSummary.totalVat)}</span>
          </div>
          <div className="ti-vat-row ti-vat-total">
            <span>รวมทั้งสิ้น</span>
            <span className="num">{formatMoney(total)}</span>
          </div>
        </div>

        <p className="ti-amount-text">
          <span className="ti-label">จำนวนเงินรวม (ตัวอักษร)</span>
          <span className="ti-amount-words">({totalText})</span>
        </p>

        {invoice.status === "void" ? (
          <p className="ti-void-note">
            ★ ใบกำกับภาษีนี้ถูกยกเลิกแล้ว{invoice.voidedAt ? ` เมื่อ ${formatDateThai(invoice.voidedAt.slice(0, 10))}` : ""}
            {invoice.voidReason ? ` — เหตุผล: ${invoice.voidReason}` : ""}
          </p>
        ) : null}

        <div className="ti-sign">
          <div className="ti-sign-box">
            <div className="ti-sign-line" />
            <div className="ti-sign-label">( ลงชื่อ ) ผู้รับเงิน/ผู้ออกเอกสาร</div>
          </div>
          <div className="ti-sign-box">
            <div className="ti-sign-line" />
            <div className="ti-sign-label">( ลงชื่อ ) ผู้จ่ายเงิน/ผู้รับเอกสาร</div>
          </div>
        </div>
      </div>
    </div>
  );
}
