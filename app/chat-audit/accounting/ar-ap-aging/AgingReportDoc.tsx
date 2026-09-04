"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/accounting/calc";
import { AGING_BUCKET_LABELS, AGING_BUCKET_ORDER, type AgingReport, type AgingRow } from "@/lib/accounting/aging";

/**
 * AgingReportDoc — รายงานลูกหนี้/เจ้าหนี้ค้างชำระตามอายุหนี้ (AR/AP Aging, เฟส 2 ส่วน G)
 *   2 ตาราง (ลูกหนี้/เจ้าหนี้) แยกตามคู่ค้า × 6 กลุ่มอายุหนี้ (0.9) + ยอดรวมต่อ bucket
 *
 * ★ read-only (ไม่แก้ตัวเลขบนจอเหมือน vat-report — รายงานนี้สรุปยอดจาก DB ตรง ๆ) · พิมพ์ได้ (mirror vat-report)
 * ★ ไม่ยิง network — render จากข้อมูลที่ server ส่งมา (Excel เป็นลิงก์ route แยก)
 */
function AgingTable({ title, rows, totals }: { title: string; rows: AgingRow[]; totals: Record<string, number> }) {
  const grandTotal = AGING_BUCKET_ORDER.reduce((s, k) => s + (totals[k] ?? 0), 0);
  return (
    <div className="ar-section">
      <div className="ar-section-title">{title}</div>
      <table className="ar-table">
        <thead>
          <tr>
            <th className="ar-col-party">คู่ค้า</th>
            {AGING_BUCKET_ORDER.map((k) => (
              <th key={k} className="ar-col-money">{AGING_BUCKET_LABELS[k]}</th>
            ))}
            <th className="ar-col-money">รวม</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={AGING_BUCKET_ORDER.length + 2} className="ar-empty">
                ไม่มีบิลค้างชำระ ณ วันที่ตั้งรายงาน
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.counterpartyName}>
                <td className="ar-c-party">{r.counterpartyName}</td>
                {AGING_BUCKET_ORDER.map((k) => (
                  <td key={k} className="ar-c-money">{r.buckets[k] ? formatMoney(r.buckets[k]) : ""}</td>
                ))}
                <td className="ar-c-money strong">{formatMoney(r.total)}</td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="ar-total">
            <td className="ar-total-label">รวมทั้งสิ้น {rows.length.toLocaleString("th-TH")} คู่ค้า</td>
            {AGING_BUCKET_ORDER.map((k) => (
              <td key={k} className="ar-c-money">{formatMoney(totals[k] ?? 0)}</td>
            ))}
            <td className="ar-c-money">{formatMoney(grandTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function AgingReportDoc({
  customerId,
  companyName,
  asOfDate,
  asOfLabel,
  fromDate = "",
  fromLabel = "",
  monthOptions = [],
  printedAt,
  report,
  excelHref,
  backHref,
}: {
  customerId: string;
  companyName: string;
  /** YYYY-MM-DD — ค่าที่ตั้งอยู่ (สำหรับช่อง date input) */
  asOfDate: string;
  /** ป้ายไทย dd/mm/พ.ศ. ของ asOfDate */
  asOfLabel: string;
  /** ★ 2026-09-04 (รอบสอง) ช่วงวันที่แบบสมุดรายวัน: จากวันที่ ("" = ไม่จำกัด — บิลทั้งหมดถึงวันวัด) */
  fromDate?: string;
  fromLabel?: string;
  /** ตัวเลือกเดือน (เหมือนหน้าสมุดรายวัน) */
  monthOptions?: { value: string; label: string }[];
  printedAt: string;
  report: AgingReport;
  excelHref: string;
  backHref: string;
}) {
  const router = useRouter();

  // ★ 2026-09-04 (รอบสอง) ผู้ใช้: "หน้าสมุดบัญชีเลือกเดือนถึงเดือน และวันที่ถึงวันที่ได้"
  //   — ชุดควบคุมเดียวกับ journal-books: ตั้งแต่/ถึง (วันที่) + ช่วงเดือน/ถึงเดือน + 📥 ดึงข้อมูล
  //   ความหมาย: กรอง "บิลที่ออกในช่วง" · ยอดค้างวัด ณ วันสิ้นช่วง (ถึง)
  function pushRange(from: string, to: string) {
    if (!to) return;
    const params = new URLSearchParams({ customer: customerId, to });
    if (from) params.set("from", from);
    router.push(`/chat-audit/accounting/ar-ap-aging?${params.toString()}`);
  }
  function lastDayOf(month: string): string {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y ?? 0, m ?? 0, 0)).getUTCDate();
    return `${month}-${String(last).padStart(2, "0")}`;
  }
  const selectedMonth = asOfDate.slice(0, 7);
  const [rangeStart, setRangeStart] = useState(fromDate ? fromDate.slice(0, 7) : selectedMonth);
  const [rangeEnd, setRangeEnd] = useState(selectedMonth);
  function applyMonthRange() {
    const [a, b] = rangeStart <= rangeEnd ? [rangeStart, rangeEnd] : [rangeEnd, rangeStart];
    if (!/^\d{4}-\d{2}$/.test(a) || !/^\d{4}-\d{2}$/.test(b)) return;
    pushRange(`${a}-01`, lastDayOf(b));
  }

  return (
    <div className="vr-shell">
      {/* ---- แถบเครื่องมือ (ซ่อนตอนพิมพ์) — โครงเดียวกับหน้าสมุดรายวัน ---- */}
      <div className="vr-toolbar no-print">
        <a href={backHref} className="vr-btn vr-btn-ghost">← กลับ</a>
        <label className="vr-month-picker">
          <span>ตั้งแต่</span>
          <input
            type="date"
            className="vr-select vr-date-in"
            value={fromDate}
            max={asOfDate || undefined}
            onChange={(e) => pushRange(e.target.value, asOfDate)}
            aria-label="วันเริ่มต้น (เว้นว่าง = บิลทั้งหมด)"
          />
        </label>
        <label className="vr-month-picker">
          <span>ถึง</span>
          <input
            type="date"
            className="vr-select vr-date-in"
            value={asOfDate}
            min={fromDate || undefined}
            onChange={(e) => e.target.value && pushRange(fromDate, e.target.value)}
            aria-label="วันสิ้นสุด (วันวัดยอดค้าง)"
          />
        </label>
        <label className="vr-month-picker">
          <span>ช่วงเดือน</span>
          <select
            className="vr-select"
            value={rangeStart}
            onChange={(e) => {
              const v = e.target.value;
              setRangeStart(v);
              if (rangeEnd < v) setRangeEnd(v);
            }}
            aria-label="เดือนเริ่มต้น"
          >
            {monthOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="vr-month-picker">
          <span>ถึงเดือน</span>
          <select
            className="vr-select"
            value={rangeEnd}
            onChange={(e) => {
              const v = e.target.value;
              setRangeEnd(v);
              if (rangeStart > v) setRangeStart(v);
            }}
            aria-label="เดือนสิ้นสุด"
          >
            {monthOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="vr-btn"
          onClick={applyMonthRange}
          title="ดึงบิลของช่วงเดือนที่เลือก (ยอดค้างวัด ณ สิ้นช่วง)"
        >
          📥 ดึงข้อมูล
        </button>
        <span className="vr-toolbar-hint">
          แสดงเฉพาะบิลเชื่อ (ลูกหนี้/เจ้าหนี้) ที่ยังค้างชำระ ณ วันที่ตั้งรายงาน — บิลที่จ่ายครบแล้วจะไม่แสดง
        </span>
        <a href={excelHref} className="vr-btn vr-btn-ghost">⬇ Excel</a>
        <button type="button" className="vr-btn vr-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
      </div>

      {/* ================= ตัวเอกสาร ================= */}
      <div className="vr-page">
        <div className="vr-head">
          <div className="vr-head-left">
            <div>วันที่พิมพ์ {printedAt}</div>
          </div>
          <div className="vr-head-center">
            <div className="vr-title">- รายงานลูกหนี้/เจ้าหนี้ค้างชำระตามอายุหนี้ -</div>
            <div className="vr-company-in strong">{companyName}</div>
            <div className="vr-month">
              {fromDate ? <>บิลตั้งแต่ {fromLabel} ถึง {asOfLabel} · ยอดค้าง ณ วันที่ {asOfLabel}</> : <>ณ วันที่ {asOfLabel}</>}
            </div>
          </div>
          <div className="vr-head-right">
            <div>Page 1</div>
          </div>
        </div>

        <AgingTable title="ลูกหนี้การค้า (AR)" rows={report.ar} totals={report.totalsByBucket.ar} />
        <AgingTable title="เจ้าหนี้การค้า (AP)" rows={report.ap} totals={report.totalsByBucket.ap} />
      </div>
    </div>
  );
}
