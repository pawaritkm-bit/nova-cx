import Link from "next/link";

/**
 * เมนู "เครื่องมือบัญชีทั้งหมด" ต่อลูกค้า — รวมทุกฟีเจอร์ที่เคยมีในหน้า /accounting (CustomerTabs)
 *   ★ ใช้ซ้ำได้ทั้งหน้า workspace และหน้าเดิม · สร้าง href เองจาก customerId/month/accountant
 *   ★ เดิมเมนูพวกนี้ฝังใน CustomerTabs (หน้าอ่านบิลเดิม) → หน้า workspace มองไม่เห็น = ฟีเจอร์หาย
 *
 * param ต่อ route ต่างกัน (คงไว้ตามของเดิมเป๊ะ):
 *   ส่วนใหญ่ ?customerId=  ·  vat-report/ar-ap-aging/journal-books/sbt/receipt-cert/wht-cert ใช้ ?customer=
 */
export default function CustomerToolsMenu({
  customerId,
  month,
  accountant,
}: {
  customerId: string;
  /** YYYY-MM (ใส่ให้ report ที่อิงเดือน) */
  month?: string | null;
  accountant?: string | null;
}) {
  const cid = encodeURIComponent(customerId);
  const m = month ? `&month=${encodeURIComponent(month)}` : "";
  const acc = accountant ? `&accountant=${encodeURIComponent(accountant)}` : "";
  const reviewMonth = month ? `?month=${encodeURIComponent(month)}&` : "?";

  // [label, href, openNewTab?] — เรียงตามหน้าเดิม (CustomerTabs)
  const groups: { title: string; items: [string, string, boolean?][] }[] = [
    {
      title: "บันทึก / รายการ",
      items: [
        ["ตรวจทาน / ออก Excel", `/chat-audit/accounting/review${reviewMonth}customerId=${cid}`],
        ["ยอดยกมา", `/chat-audit/accounting/opening?customerId=${cid}`],
        ["ลงบันทึกบัญชีเอง", `/chat-audit/accounting/journal-entry?customerId=${cid}`],
        ["รายการบันทึกซ้ำ", `/chat-audit/accounting/recurring-journal?customerId=${cid}`],
        ["รับ/จ่ายเงิน", `/chat-audit/accounting/payments?customerId=${cid}`],
        ["เงินสดย่อย", `/chat-audit/accounting/petty-cash?customerId=${cid}`],
        ["ปรับปรุงอัตราแลกเปลี่ยนปลายงวด", `/chat-audit/accounting/fx-revaluation?customerId=${cid}`],
      ],
    },
    {
      title: "เอกสารขาย/ซื้อ",
      items: [
        ["ใบเสนอราคา/PO/วางบิล", `/chat-audit/accounting/sales-documents?customerId=${cid}`],
        ["ใบแจ้งหนี้วนซ้ำ", `/chat-audit/accounting/recurring-invoice?customerId=${cid}`],
        ["ใบกำกับภาษี", `/chat-audit/accounting/tax-invoices?customerId=${cid}`],
        ["ใบลดหนี้/เพิ่มหนี้", `/chat-audit/accounting/credit-debit-notes?customerId=${cid}`],
        ["＋ ใบรับรองแทนใบเสร็จ", `/chat-audit/accounting/receipt-cert?customer=${cid}`, true],
        ["＋ หนังสือรับรองหัก ณ ที่จ่าย", `/chat-audit/accounting/wht-cert?customer=${cid}`, true],
      ],
    },
    {
      title: "ภาษี / รายงานราชการ",
      items: [
        ["รายงานภาษีซื้อ", `/chat-audit/accounting/vat-report?customer=${cid}&type=purchase${m}`, true],
        ["รายงานภาษีขาย", `/chat-audit/accounting/vat-report?customer=${cid}&type=sale${m}`, true],
        ["สมุดรายวัน", `/chat-audit/accounting/journal-books?customer=${cid}${m}`, true],
        ["ภธ.40", `/chat-audit/accounting/sbt-report?customer=${cid}${m}`, true],
      ],
    },
    {
      title: "รายงาน / งบ",
      items: [
        ["งบการเงิน", `/chat-audit/accounting/reports?customerId=${cid}`],
        ["งบการเงินฉบับทางการ", `/chat-audit/accounting/financial-statements?customerId=${cid}`],
        ["ลูกหนี้/เจ้าหนี้ค้างชำระ", `/chat-audit/accounting/ar-ap-aging?customer=${cid}`, true],
        ["งบประมาณ", `/chat-audit/accounting/budget?customerId=${cid}`],
      ],
    },
    {
      title: "กระทบยอด / สเตทเมนต์",
      items: [
        ["กระทบยอดธนาคาร", `/chat-audit/accounting/bank-reconciliation?customerId=${cid}`],
        ["แยกสเตทเมนต์/รายงานแพลตฟอร์ม", `/chat-audit/accounting/statement?customerId=${cid}`],
        ["mapping FlowAccount", `/chat-audit/accounting/flowaccount-map?customerId=${cid}`],
      ],
    },
    {
      title: "ทรัพย์สิน / สต็อก / เงินเดือน",
      items: [
        ["ทรัพย์สินถาวร", `/chat-audit/accounting/fixed-assets?customerId=${cid}`],
        ["สต็อกสินค้า", `/chat-audit/accounting/inventory?customerId=${cid}`],
        ["ทะเบียนพนักงาน", `/chat-audit/accounting/payroll-employees?customerId=${cid}`],
        ["เงินเดือน", `/chat-audit/accounting/payroll?customerId=${cid}`],
      ],
    },
    {
      title: "ผู้ช่วย AI",
      items: [
        ["💬 ถาม AI", `/chat-audit/accounting/ask-ai?customerId=${cid}`],
      ],
    },
  ];

  return (
    <details className="cust-tools">
      <summary className="btn">🧰 เครื่องมือบัญชีทั้งหมด</summary>
      <div className="cust-tools-pop">
        {groups.map((grp) => (
          <div key={grp.title} className="cust-tools-grp">
            <div className="cust-tools-grp-title">{grp.title}</div>
            <div className="cust-tools-links">
              {grp.items.map(([label, href, newTab]) =>
                newTab ? (
                  <a key={label} href={href} className="btn btn-ghost" target="_blank" rel="noopener">
                    {label}
                  </a>
                ) : (
                  <Link key={label} href={`${href}${acc}`} className="btn btn-ghost">
                    {label}
                  </Link>
                )
              )}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
