"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/accounting/calc";
import { updateCustomerFieldsAction } from "../customer-admin-actions";
import type { VatReportKind, VatReportRow, VatReportTotals } from "@/lib/accounting/vat-report";

/** วันที่ ISO (YYYY-MM-DD) → dd/mm/พ.ศ. (คืน "-" ถ้าไม่มี/พัง) */
function thaiDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "-";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

/**
 * รายงานภาษีซื้อ / รายงานภาษีขาย — เอกสารพิมพ์/บันทึก PDF (ตามฟอร์มราชการ)
 *
 * โครงหัวรายงาน (3 คอลัมน์):
 *   ซ้าย = วันที่/เวลาพิมพ์ · กลาง = ชื่อรายงาน + ชื่อบริษัท + เดือนภาษี · ขวา = Page/สนญ./เลขภาษีลูกค้า
 * ตาราง: ลำดับ | ใบกำกับ(วดป/เลขที่) | ชื่อคู่ค้า | เลขภาษีคู่ค้า | สถานประกอบการ(สนญ./สาขา) |
 *        มูลค่าคิด VAT | มูลค่ายกเว้น VAT | ภาษีมูลค่าเพิ่ม
 * footer: รวมทั้งสิ้น N รายการ + ยอดรวม 3 คอลัมน์
 *
 * ★ .no-print ซ่อนตอนพิมพ์ (แถบเครื่องมือ) · prefix vr- กันชนสไตล์เดิม (acc- / rcv-)
 * ★ ไม่ยิง network — render จากข้อมูลที่ server ส่งมา (Excel เป็นลิงก์ route แยก)
 */
export default function VatReportDoc({
  customerId,
  kind,
  companyName,
  companyTaxId,
  companyAddress,
  periodLabel,
  fromDate,
  toDate,
  selectedMonth,
  monthOptions,
  printedAt,
  rows,
  totals,
  excelHref,
  backHref,
}: {
  /** id ลูกค้า — ใช้สร้าง URL เปลี่ยนช่วงวัน + บันทึกที่อยู่ถาวร */
  customerId: string;
  kind: VatReportKind;
  companyName: string;
  companyTaxId: string;
  /** ที่อยู่บริษัทลูกค้า (จาก customers.address) · "" = ยังไม่กรอก → เว้น/ขีดเส้น */
  companyAddress: string;
  /** ป้ายช่วงหัวรายงาน เช่น "เดือนภาษี มิถุนายน ปี พ.ศ. 2569" หรือ "ตั้งแต่ … ถึง …" */
  periodLabel: string;
  /** ช่วงวันที่ที่เลือกอยู่ (YYYY-MM-DD) สำหรับช่อง date input */
  fromDate: string;
  toDate: string;
  /** เดือนอ้างอิงของปุ่มลัด "ทั้งเดือน" (YYYY-MM) */
  selectedMonth: string;
  /** ตัวเลือกเดือนย้อนหลังสำหรับปุ่มลัด "ทั้งเดือน" */
  monthOptions: { value: string; label: string }[];
  /** วันที่/เวลาพิมพ์ (เวลาไทย) เช่น "04/08/2569 09:30" */
  printedAt: string;
  rows: VatReportRow[];
  totals: VatReportTotals;
  excelHref: string;
  backHref: string;
}) {
  const router = useRouter();
  const title = kind === "purchase" ? "- รายงานภาษีซื้อ -" : "- รายงานภาษีขาย -";
  const partyHeader =
    kind === "purchase" ? "ชื่อผู้ขายสินค้า/ผู้ให้บริการ" : "ชื่อผู้ซื้อสินค้า/ผู้รับบริการ";

  // ---- หัวรายงานแก้ได้ inline (prints) — prefill จากข้อมูลลูกค้า ----
  const [name, setName] = useState(companyName);
  const [taxId, setTaxId] = useState(companyTaxId);
  const [address, setAddress] = useState(companyAddress);

  // ---- บันทึกที่อยู่ถาวรให้ลูกค้า (optional) ----
  const [saving, startSave] = useTransition();
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  /** นำทางไปช่วงวันใหม่ (คง customer/type) เพื่อ re-query ตามช่วง [from, to] */
  function pushRange(from: string, to: string) {
    const params = new URLSearchParams();
    params.set("customer", customerId);
    params.set("type", kind);
    params.set("from", from);
    params.set("to", to);
    router.push(`/chat-audit/accounting/vat-report?${params.toString()}`);
  }

  /** ปุ่มลัด "ทั้งเดือน": เลือกเดือน YYYY-MM → from=วันที่1, to=วันสุดท้ายของเดือนนั้น */
  function onWholeMonth(month: string) {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // วันสุดท้ายของเดือน
    pushRange(`${month}-01`, `${month}-${String(last).padStart(2, "0")}`);
  }

  // ลิงก์ไปสมุดรายวันเล่มที่ตรงกัน (ภาษีขาย→เล่มขาย, ภาษีซื้อ→เล่มซื้อ) ลูกค้า+ช่วงเดียวกัน
  const jbParams = new URLSearchParams({
    customer: customerId,
    from: fromDate,
    to: toDate,
    book: kind, // "purchase" | "sale"
  });
  const journalHref = `/chat-audit/accounting/journal-books?${jbParams.toString()}`;
  const journalLabel = kind === "sale" ? "→ สมุดรายวันขาย" : "→ สมุดรายวันซื้อ";

  /** บันทึกที่อยู่ปัจจุบันให้ลูกค้าถาวร (customers.address) */
  function saveAddress() {
    setSaveMsg(null);
    startSave(async () => {
      const res = await updateCustomerFieldsAction(customerId, { address });
      setSaveMsg({ ok: res.ok, text: res.ok ? "บันทึกที่อยู่ให้ลูกค้าแล้ว" : res.message });
    });
  }

  return (
    <div className="vr-shell">
      {/* ---- แถบเครื่องมือ (ซ่อนตอนพิมพ์) ---- */}
      <div className="vr-toolbar no-print">
        <a href={backHref} className="vr-btn vr-btn-ghost">← กลับ</a>
        <label className="vr-month-picker">
          <span>ตั้งแต่</span>
          <input
            type="date"
            className="vr-select vr-date-in"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => e.target.value && pushRange(e.target.value, toDate)}
            aria-label="วันเริ่มต้น"
          />
        </label>
        <label className="vr-month-picker">
          <span>ถึง</span>
          <input
            type="date"
            className="vr-select vr-date-in"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => e.target.value && pushRange(fromDate, e.target.value)}
            aria-label="วันสิ้นสุด"
          />
        </label>
        <label className="vr-month-picker">
          <span>ทั้งเดือน</span>
          <select
            className="vr-select"
            value={selectedMonth}
            onChange={(e) => onWholeMonth(e.target.value)}
            aria-label="เลือกทั้งเดือน"
          >
            {monthOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <span className="vr-toolbar-hint">เลือกช่วงวัน หรือกด “ทั้งเดือน” · แล้วพิมพ์/บันทึก PDF หรือ Excel</span>
        <a href={journalHref} className="vr-btn vr-btn-ghost">{journalLabel}</a>
        <a href={excelHref} className="vr-btn vr-btn-ghost">⬇ Excel</a>
        <button type="button" className="vr-btn vr-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
      </div>

      {/* ================= ตัวเอกสาร ================= */}
      <div className="vr-page">
        {/* หัวรายงาน 3 คอลัมน์ */}
        <div className="vr-head">
          <div className="vr-head-left">
            <div>วันที่พิมพ์ {printedAt}</div>
          </div>
          <div className="vr-head-center">
            <div className="vr-title">{title}</div>
            <input
              className="vr-in vr-company-in"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ชื่อกิจการ"
              aria-label="ชื่อกิจการ"
            />
            {/* ที่อยู่บริษัทลูกค้า — แก้ได้ (prints) · textarea ตัดบรรทัดเองเมื่อยาว (กันตกขอบ) */}
            <textarea
              className="vr-in vr-address-in"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="ที่อยู่กิจการ (พิมพ์ใส่ได้)"
              aria-label="ที่อยู่กิจการ"
              rows={1}
            />
            <div className="vr-month">{periodLabel}</div>
          </div>
          <div className="vr-head-right">
            <div>Page 1</div>
            <div>สำนักงานใหญ่</div>
            <div className="vr-taxid-line">
              เลขประจำตัวผู้เสียภาษี{" "}
              <input
                className="vr-in vr-taxid-in"
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
                placeholder="-"
                aria-label="เลขประจำตัวผู้เสียภาษี"
              />
            </div>
          </div>
        </div>

        {/* แถวช่วยเหลือใต้หัว (ซ่อนตอนพิมพ์): บันทึกที่อยู่ถาวรให้ลูกค้า */}
        <div className="vr-addr-actions no-print">
          <button
            type="button"
            className="vr-btn vr-btn-ghost vr-btn-sm"
            onClick={saveAddress}
            disabled={saving}
          >
            {saving ? "กำลังบันทึก…" : "💾 บันทึกที่อยู่นี้ให้ลูกค้า"}
          </button>
          {saveMsg && (
            <span className={saveMsg.ok ? "vr-save-ok" : "vr-save-err"}>{saveMsg.text}</span>
          )}
        </div>

        {/* ตารางรายการ */}
        <table className="vr-table">
          <thead>
            <tr>
              <th rowSpan={2} className="vr-col-seq">ลำดับที่</th>
              <th colSpan={2} className="vr-col-inv">ใบกำกับภาษี</th>
              <th rowSpan={2} className="vr-col-party">{partyHeader}</th>
              <th rowSpan={2} className="vr-col-tax">เลขประจำตัว<br />ผู้เสียภาษีอากร</th>
              <th colSpan={2} className="vr-col-estab">สถานประกอบการ</th>
              <th rowSpan={2} className="vr-col-money">มูลค่าสินค้า/บริการ<br />ที่คิด VAT</th>
              <th rowSpan={2} className="vr-col-money">มูลค่าสินค้า/บริการ<br />ที่ยกเว้น VAT</th>
              <th rowSpan={2} className="vr-col-money">จำนวนเงิน<br />ภาษีมูลค่าเพิ่ม</th>
            </tr>
            <tr>
              <th className="vr-col-date">วัน/เดือน/ปี</th>
              <th className="vr-col-no">เลขที่</th>
              <th className="vr-col-ho">สำนักงานใหญ่</th>
              <th className="vr-col-branch">สาขาที่</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="vr-empty">ไม่มีรายการในช่วงวันที่นี้</td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={r.entryId}>
                  <td className="vr-c-seq">{i + 1}</td>
                  <td className="vr-c-date">{thaiDate(r.docDate)}</td>
                  <td className="vr-c-no">{r.docNo || "-"}</td>
                  <td className="vr-c-party">{r.partyName || "-"}</td>
                  <td className="vr-c-tax">{r.partyTaxId || "-"}</td>
                  <td className="vr-c-ho">{r.isHeadOffice ? "X" : ""}</td>
                  <td className="vr-c-branch">{r.isHeadOffice ? "" : "-"}</td>
                  <td className="vr-c-money">{formatMoney(r.baseVat)}</td>
                  <td className="vr-c-money">{formatMoney(r.baseExempt)}</td>
                  <td className="vr-c-money">{formatMoney(r.vat)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="vr-total">
              <td colSpan={7} className="vr-total-label">
                รวมทั้งสิ้น {totals.count.toLocaleString("th-TH")} รายการ
              </td>
              <td className="vr-c-money">{formatMoney(totals.baseVatTotal)}</td>
              <td className="vr-c-money">{formatMoney(totals.baseExemptTotal)}</td>
              <td className="vr-c-money">{formatMoney(totals.vatTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
