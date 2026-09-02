"use client";

import { useState } from "react";
import {
  canUseAccountingTool,
  type AccountingToolScope,
} from "@/lib/accounting/customer-tool-policy";

/**
 * เมนู "เครื่องมือบัญชีทั้งหมด" ต่อลูกค้า — รวมทุกฟีเจอร์ที่เคยมีในหน้า /accounting (CustomerTabs)
 *   ★ เปิด "ในหน้าเดิม" (iframe overlay + ?embed=1) — ไม่เด้งออกไปหน้าอื่น (ตามที่ผู้ใช้ต้องการ)
 *   ★ วงจรบัญชีรายเดือนใช้ร่วมกันทั้งบุคคลธรรมดาและนิติบุคคล
 *   ★ จำกัดเฉพาะงานปิดงบ/งบทางการปลายปีไว้สำหรับนิติบุคคล
 *
 * param ต่อ route ต่างกัน (คงไว้ตามของเดิมเป๊ะ):
 *   ส่วนใหญ่ ?customerId=  ·  vat-report/ar-ap-aging/journal-books/sbt/receipt-cert/wht-cert ใช้ ?customer=
 */
type Tool = { label: string; href: string; scope?: AccountingToolScope };
type Group = { title: string; items: Tool[] };

export default function CustomerToolsMenu({
  customerId,
  month,
  accountant,
  customerType,
}: {
  customerId: string;
  month?: string | null;
  accountant?: string | null;
  /** 'company' = นิติบุคคล · 'individual' = บุคคลธรรมดา · null = ยังไม่จัดประเภท */
  customerType?: "company" | "individual" | null;
}) {
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [openLabel, setOpenLabel] = useState<string>("");

  const cid = encodeURIComponent(customerId);
  const m = month ? `&month=${encodeURIComponent(month)}` : "";
  const reviewMonth = month ? `?month=${encodeURIComponent(month)}&` : "?";
  const groups: Group[] = [
    {
      title: "บันทึก / รายการ",
      items: [
        { label: "ตรวจทาน / ออก Excel", href: `/chat-audit/accounting/review${reviewMonth}customerId=${cid}` },
        { label: "ยอดยกมา", href: `/chat-audit/accounting/opening?customerId=${cid}` },
        { label: "ลงบันทึกบัญชีเอง", href: `/chat-audit/accounting/journal-entry?customerId=${cid}` },
        { label: "รายการบันทึกซ้ำ", href: `/chat-audit/accounting/recurring-journal?customerId=${cid}` },
        { label: "รับ/จ่ายเงิน", href: `/chat-audit/accounting/payments?customerId=${cid}` },
        { label: "เงินสดย่อย", href: `/chat-audit/accounting/petty-cash?customerId=${cid}` },
        { label: "ปรับปรุงอัตราแลกเปลี่ยนปลายงวด", href: `/chat-audit/accounting/fx-revaluation?customerId=${cid}` },
        // ★ 2026-09-02 — ผังบัญชี: เพิ่ม/แก้รหัส (เลขซ้ำได้ ชื่อห้ามซ้ำ) — ผังเป็นของสำนักงาน (ทุกลูกค้าใช้ร่วม)
        { label: "ผังบัญชี (เพิ่ม/แก้รหัสบัญชี)", href: `/chat-audit/admin/chart-of-accounts` },
      ],
    },
    {
      title: "เอกสารขาย/ซื้อ",
      items: [
        { label: "ใบเสนอราคา/PO/วางบิล", href: `/chat-audit/accounting/sales-documents?customerId=${cid}` },
        { label: "ใบแจ้งหนี้วนซ้ำ", href: `/chat-audit/accounting/recurring-invoice?customerId=${cid}` },
        { label: "ใบกำกับภาษี", href: `/chat-audit/accounting/tax-invoices?customerId=${cid}` },
        { label: "ใบลดหนี้/เพิ่มหนี้", href: `/chat-audit/accounting/credit-debit-notes?customerId=${cid}` },
        { label: "＋ ใบรับรองแทนใบเสร็จ", href: `/chat-audit/accounting/receipt-cert?customer=${cid}` },
        { label: "＋ หนังสือรับรองหัก ณ ที่จ่าย", href: `/chat-audit/accounting/wht-cert?customer=${cid}` },
      ],
    },
    {
      title: "ภาษี / รายงานราชการ",
      items: [
        { label: "รายงานภาษีซื้อ", href: `/chat-audit/accounting/vat-report?customer=${cid}&type=purchase${m}` },
        { label: "รายงานภาษีขาย", href: `/chat-audit/accounting/vat-report?customer=${cid}&type=sale${m}` },
        { label: "สมุดรายวัน 5 เล่ม (ซื้อ/ขาย/รับ/จ่าย/ทั่วไป)", href: `/chat-audit/accounting/journal-books?customer=${cid}${m}` },
        { label: "ภธ.40", href: `/chat-audit/accounting/sbt-report?customer=${cid}${m}` },
      ],
    },
    {
      title: "รายงาน / งบ",
      items: [
        { label: "งบการเงิน", href: `/chat-audit/accounting/reports?customerId=${cid}`, scope: "company_closing" },
        { label: "งบการเงินฉบับทางการ", href: `/chat-audit/accounting/financial-statements?customerId=${cid}`, scope: "company_closing" },
        { label: "ลูกหนี้/เจ้าหนี้ค้างชำระ", href: `/chat-audit/accounting/ar-ap-aging?customer=${cid}` },
        { label: "งบประมาณ", href: `/chat-audit/accounting/budget?customerId=${cid}` },
      ],
    },
    {
      title: "กระทบยอด",
      items: [
        // ★ "แยกสเตทเมนต์/รายงานแพลตฟอร์ม" ย้ายไปอยู่ในกล่อง "อัปโหลดไฟล์เอง" (2026-09-01)
        { label: "กระทบยอดธนาคาร", href: `/chat-audit/accounting/bank-reconciliation?customerId=${cid}` },
      ],
    },
    {
      title: "ทรัพย์สิน / สต็อก / เงินเดือน",
      items: [
        { label: "ทรัพย์สินถาวร", href: `/chat-audit/accounting/fixed-assets?customerId=${cid}` },
        { label: "สต็อกสินค้า", href: `/chat-audit/accounting/inventory?customerId=${cid}` },
        { label: "ทะเบียนพนักงาน", href: `/chat-audit/accounting/payroll-employees?customerId=${cid}` },
        { label: "เงินเดือน", href: `/chat-audit/accounting/payroll?customerId=${cid}` },
      ],
    },
    {
      title: "ผู้ช่วย AI",
      items: [{ label: "💬 ถาม AI", href: `/chat-audit/accounting/ask-ai?customerId=${cid}` }],
    },
  ];

  /** เปิดเครื่องมือ "ในหน้าเดิม" — iframe overlay (ต่อ ?embed=1 ให้หน้าซ่อน nav) */
  function openTool(href: string, label: string) {
    const sep = href.includes("?") ? "&" : "?";
    const acc = accountant ? `&accountant=${encodeURIComponent(accountant)}` : "";
    setOpenUrl(`${href}${sep}embed=1${acc}`);
    setOpenLabel(label);
  }

  return (
    <>
      <details className="cust-tools" name="cust-menu">
        <summary className="btn">🧰 เครื่องมือบัญชีทั้งหมด</summary>
        <div className="cust-tools-pop">
          {groups.map((grp) => {
            const items = grp.items.filter((it) => canUseAccountingTool(customerType ?? null, it.scope));
            if (items.length === 0) return null;
            return (
              <div key={grp.title} className="cust-tools-grp">
                <div className="cust-tools-grp-title">{grp.title}</div>
                <div className="cust-tools-links">
                  {items.map((it) => (
                    <button key={it.label} type="button" className="btn btn-ghost" onClick={() => openTool(it.href, it.label)}>
                      {it.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {customerType === "individual" ? (
            <div className="cust-tools-note">
              * บุคคลธรรมดาใช้วงจรบัญชีรายเดือนได้ครบเหมือนนิติบุคคล แต่ไม่แสดงงานปิดงบและงบการเงินทางการปลายปี
            </div>
          ) : customerType === null ? (
            <div className="cust-tools-note">* กรุณาตั้งประเภทลูกค้าที่ปุ่ม “จัดการลูกค้า” ก่อนใช้เครื่องมือบัญชี</div>
          ) : null}
        </div>
      </details>

      {/* overlay เปิดเครื่องมือในหน้าเดิม (iframe) — ปิดแล้วกลับมาที่ workspace */}
      {openUrl ? (
        <div className="tool-overlay" role="dialog" aria-modal="true" aria-label={openLabel}>
          <div className="tool-overlay-bar">
            <b>{openLabel}</b>
            <span style={{ flex: 1 }} />
            <a href={openUrl.replace(/([?&])embed=1(&|$)/, "$1").replace(/[?&]$/, "")} target="_blank" rel="noopener" className="btn btn-ghost">
              เปิดแท็บใหม่ ↗
            </a>
            <button type="button" className="btn" onClick={() => setOpenUrl(null)}>✕ ปิด</button>
          </div>
          <iframe className="tool-overlay-frame" src={openUrl} title={openLabel} />
        </div>
      ) : null}
    </>
  );
}
