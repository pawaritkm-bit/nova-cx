"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/accounting/calc";
import {
  BOOK_ORDER,
  BOOK_LABELS,
  visibleBooks,
  zipPosting,
  type JournalBook,
  type BookKind,
} from "@/lib/accounting/journal-books";
import type { SkippedEntry } from "@/lib/accounting/journal";

/** วันที่ ISO → dd/mm/พ.ศ. (คืน "-" ถ้าไม่มี) */
function thaiDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "-";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

/**
 * สมุดรายวัน 5 เล่ม — เอกสารพิมพ์/บันทึก PDF (ต่อลูกค้า/เดือน)
 *   แต่ละเล่ม: วันที่ | เลขที่ | คำอธิบาย | บัญชี(เดบิต) | เดบิต | บัญชี(เครดิต) | เครดิต + รวมเดบิต/เครดิต
 *   ★ reuse สไตล์ vr-* (vat-report.css) + jb-* (journal-books.css) · แต่ละเล่มขึ้นหน้าใหม่ตอนพิมพ์
 *   ★ ไม่ยิง network · PDPA: ไม่ log ค่าใด ๆ
 */
/** ตัวเลือกเล่มบน dropdown: ทั้งหมด + 5 เล่ม (BookKind) */
const BOOK_CHOICES: { value: string; label: string }[] = [
  { value: "all", label: "ทุกเล่ม (5 เล่ม)" },
  ...BOOK_ORDER.map((k) => ({ value: k, label: BOOK_LABELS[k] })),
];

export default function JournalBooksDoc({
  customerId,
  companyName,
  periodLabel,
  fromDate,
  toDate,
  selectedMonth,
  monthOptions,
  initialBook,
  printedAt,
  books,
  skipped,
  backHref,
}: {
  /** id ลูกค้า — ใช้สร้าง URL เปลี่ยนช่วงวัน */
  customerId: string;
  companyName: string;
  /** ป้ายช่วงหัวสมุดรายวัน เช่น "มิถุนายน ปี พ.ศ. 2569" หรือ "ตั้งแต่ … ถึง …" */
  periodLabel: string;
  /** ช่วงวันที่ที่เลือกอยู่ (YYYY-MM-DD) */
  fromDate: string;
  toDate: string;
  /** เดือนอ้างอิงของปุ่มลัด "ทั้งเดือน" (YYYY-MM) */
  selectedMonth: string;
  monthOptions: { value: string; label: string }[];
  /** เล่มเริ่มต้น (ส่งมาทาง ?book= จากรายงานภาษี) — "all" ถ้าไม่ระบุ */
  initialBook: string;
  printedAt: string;
  books: Record<BookKind, JournalBook>;
  skipped: SkippedEntry[];
  backHref: string;
}) {
  const router = useRouter();
  // เล่มที่เลือก (client) — normalize ผ่าน visibleBooks ตอน render
  const [book, setBook] = useState<string>(
    BOOK_CHOICES.some((c) => c.value === initialBook) ? initialBook : "all"
  );
  const shownBooks = visibleBooks(book);

  // ลิงก์ Excel ตามช่วงวัน + เล่มที่เลือก (book != all → เฉพาะเล่มนั้น)
  const exParams = new URLSearchParams({ customer: customerId, from: fromDate, to: toDate });
  if (book !== "all") exParams.set("book", book);
  const excelHref = `/chat-audit/accounting/journal-books/export?${exParams.toString()}`;

  /** นำทางไปช่วงวันใหม่ (คง customer + เล่มที่เลือกอยู่) */
  function pushRange(from: string, to: string) {
    const params = new URLSearchParams();
    params.set("customer", customerId);
    params.set("from", from);
    params.set("to", to);
    if (book !== "all") params.set("book", book);
    router.push(`/chat-audit/accounting/journal-books?${params.toString()}`);
  }

  /** ปุ่มลัด "ทั้งเดือน": เลือกเดือน YYYY-MM → from=วันที่1, to=วันสุดท้ายของเดือน */
  function onWholeMonth(month: string) {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    pushRange(`${month}-01`, `${month}-${String(last).padStart(2, "0")}`);
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
        <label className="vr-month-picker">
          <span>เล่ม</span>
          <select
            className="vr-select"
            value={book}
            onChange={(e) => setBook(e.target.value)}
            aria-label="เลือกเล่มสมุดรายวัน"
          >
            {BOOK_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>
        <span className="vr-toolbar-hint" style={{ flex: 1 }} />
        <a href={excelHref} className="vr-btn vr-btn-ghost">⬇ Excel</a>
        <button type="button" className="vr-btn vr-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
      </div>

      {/* บิลที่ลงบัญชีไม่ได้ (ตกหล่น) — เตือนบนจอ ไม่พิมพ์ */}
      {skipped.length > 0 ? (
        <div className="vr-note no-print">
          <strong>มี {skipped.length} บิลที่ยังลงสมุดรายวันไม่ได้</strong> (ไม่ถูกนับในเล่มใด) —
          กรุณาแก้ให้ครบก่อนออกงบ: ระบุประเภทซื้อ/ขาย, เลือกบัญชีทุกบรรทัด, ระบุวิธีรับ/จ่ายเงิน
        </div>
      ) : null}

      {/* ================= เล่มที่เลือก (ทั้งหมด/เล่มเดียว) ================= */}
      <div className="vr-page">
        {/* หัวรวม */}
        <div className="vr-head">
          <div className="vr-head-left"><div>วันที่พิมพ์ {printedAt}</div></div>
          <div className="vr-head-center">
            <div className="vr-title">- สมุดรายวัน -</div>
            <div className="vr-company">{companyName}</div>
            <div className="vr-month">{periodLabel}</div>
          </div>
          <div className="vr-head-right"><div>สำนักงานใหญ่</div></div>
        </div>

        {shownBooks.map((kind) => (
          <BookSection key={kind} book={books[kind]} />
        ))}
      </div>
    </div>
  );
}

/** 1 เล่ม = หัวข้อ + ตาราง + แถวรวม (ขึ้นหน้าใหม่ตอนพิมพ์) */
function BookSection({ book }: { book: JournalBook }) {
  return (
    <section className="jb-book">
      <h2 className="jb-book-title">{book.label}</h2>
      <table className="vr-table jb-table">
        <thead>
          <tr>
            <th className="jb-col-date">วันที่</th>
            <th className="jb-col-no">เลขที่</th>
            <th className="jb-col-desc">คำอธิบาย</th>
            <th className="jb-col-acct">บัญชี (เดบิต)</th>
            <th className="vr-col-money">เดบิต</th>
            <th className="jb-col-acct">บัญชี (เครดิต)</th>
            <th className="vr-col-money">เครดิต</th>
          </tr>
        </thead>
        <tbody>
          {book.postings.length === 0 ? (
            <tr>
              <td colSpan={7} className="vr-empty">ไม่มีรายการในเล่มนี้</td>
            </tr>
          ) : (
            book.postings.map((p) => {
              const rows = zipPosting(p);
              return rows.map((r, i) => (
                <tr key={`${p.entryId}-${i}`} className={i === 0 ? "jb-firstrow" : undefined}>
                  {/* วันที่/เลขที่/คำอธิบาย โชว์เฉพาะแถวแรกของใบสำคัญ */}
                  <td className="jb-c-date">{i === 0 ? thaiDate(p.date) : ""}</td>
                  <td className="jb-c-no">{i === 0 ? (p.docNo || "-") : ""}</td>
                  <td className="jb-c-desc">{i === 0 ? (p.description || "-") : ""}</td>
                  <td className="jb-c-acct">
                    {r.debit ? `${r.debit.accountCode} ${r.debit.accountName}` : ""}
                  </td>
                  <td className="vr-c-money">{r.debit ? formatMoney(r.debit.amount) : ""}</td>
                  <td className="jb-c-acct jb-c-credit">
                    {r.credit ? `${r.credit.accountCode} ${r.credit.accountName}` : ""}
                  </td>
                  <td className="vr-c-money">{r.credit ? formatMoney(r.credit.amount) : ""}</td>
                </tr>
              ));
            })
          )}
        </tbody>
        <tfoot>
          <tr className="vr-total">
            <td colSpan={4} className="vr-total-label">
              รวม {book.postings.length.toLocaleString("th-TH")} รายการ
            </td>
            <td className="vr-c-money">{formatMoney(book.totalDebit)}</td>
            <td />
            <td className="vr-c-money">{formatMoney(book.totalCredit)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
