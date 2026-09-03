"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney, parseAmountInput, round2 } from "@/lib/accounting/calc";
import { downloadExcelFromPost } from "@/lib/accounting/excel-download";
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

/** แถวสมุดรายวันแบบแก้ได้ (client-only) — เดบิต/เครดิตเก็บเป็นข้อความ, parse ตอนคิดยอด */
type JbEditRow = {
  key: number;
  dateText: string;
  docNo: string;
  description: string;
  debitAcct: string;
  debit: string;
  creditAcct: string;
  credit: string;
};

/** แตกใบสำคัญของ 1 เล่มเป็นแถวแก้ได้ (วันที่/เลขที่/คำอธิบายโชว์เฉพาะแถวแรกของใบ) */
function initRows(book: JournalBook): JbEditRow[] {
  const out: JbEditRow[] = [];
  let k = 0;
  for (const p of book.postings) {
    const rows = zipPosting(p);
    rows.forEach((r, i) => {
      out.push({
        key: k++,
        dateText: i === 0 ? thaiDate(p.date) : "",
        docNo: i === 0 ? p.docNo ?? "" : "",
        description: i === 0 ? p.description : "",
        debitAcct: r.debit ? `${r.debit.accountCode} ${r.debit.accountName}` : "",
        debit: r.debit ? formatMoney(r.debit.amount) : "",
        creditAcct: r.credit ? `${r.credit.accountCode} ${r.credit.accountName}` : "",
        credit: r.credit ? formatMoney(r.credit.amount) : "",
      });
    });
  }
  return out;
}

/** นับ "รายการ" (ใบสำคัญ) = แถวที่ขึ้นต้นใบใหม่ (มีวันที่/เลขที่/คำอธิบาย) */
function countDocs(rows: JbEditRow[]): number {
  return rows.filter((r) => r.dateText.trim() || r.docNo.trim() || r.description.trim()).length;
}

/**
 * สมุดรายวัน 5 เล่ม — เอกสารพิมพ์/บันทึก PDF/Excel (ต่อลูกค้า/เดือน)
 *   แต่ละเล่ม: วันที่ | เลขที่ | คำอธิบาย | บัญชี(เดบิต) | เดบิต | บัญชี(เครดิต) | เครดิต + รวมเดบิต/เครดิต
 *   ★ ทุกช่องแก้ได้ (client-only) — พิมพ์และ Excel = ตามที่แก้บนจอ · ไม่บันทึกกลับบิลจริง
 *   ★ reuse สไตล์ vr-* (vat-report.css) + jb-* (journal-books.css) · แต่ละเล่มขึ้นหน้าใหม่ตอนพิมพ์
 *   ★ ไม่ยิง network ตอนแก้ · Excel ยิง POST ตอนกดปุ่มเท่านั้น · PDPA: ไม่ log ค่า
 */
/** ตัวเลือกเล่มบน dropdown: ทั้งหมด + 5 เล่ม
 *  ★ 2026-09-03 (รอบสอง) ผู้ใช้: "ย้ายบัญชีแยกประเภทไปหน้างบการเงิน ตัดออกจากหน้าสมุดรายวัน"
 *    — บัญชีแยกประเภทอยู่ที่หน้ารายงาน/งบการเงิน (แท็บบัญชีแยกประเภท) ที่เดียว ไม่ซ้ำสองที่ */
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

  // ---- แถวแก้ได้ต่อเล่ม (client-only) — init ครั้งเดียวจาก props books ----
  const [bookRows, setBookRows] = useState<Record<BookKind, JbEditRow[]>>(() => {
    const rec = {} as Record<BookKind, JbEditRow[]>;
    for (const k of BOOK_ORDER) rec[k] = initRows(books[k]);
    return rec;
  });
  // เริ่ม key เพิ่มใหม่ที่เลขสูง ๆ กันชนกับ key เริ่มต้น (0..n ต่อเล่ม)
  const [nextKey, setNextKey] = useState(1_000_000);

  // ยอดรวมเดบิต/เครดิต + จำนวนรายการต่อเล่ม — คิดใหม่สดจากที่แก้บนจอ
  const bookTotals = useMemo(() => {
    const rec = {} as Record<BookKind, { debit: number; credit: number; docs: number }>;
    for (const k of BOOK_ORDER) {
      let debit = 0;
      let credit = 0;
      for (const r of bookRows[k]) {
        if (r.debit.trim()) debit += parseAmountInput(r.debit);
        if (r.credit.trim()) credit += parseAmountInput(r.credit);
      }
      rec[k] = { debit: round2(debit), credit: round2(credit), docs: countDocs(bookRows[k]) };
    }
    return rec;
  }, [bookRows]);

  function updateRow(kind: BookKind, key: number, patch: Partial<JbEditRow>) {
    setBookRows((prev) => ({
      ...prev,
      [kind]: prev[kind].map((r) => (r.key === key ? { ...r, ...patch } : r)),
    }));
  }
  function addRow(kind: BookKind) {
    const nk = nextKey;
    setNextKey((k) => k + 1);
    setBookRows((prev) => ({
      ...prev,
      [kind]: [
        ...prev[kind],
        { key: nk, dateText: "", docNo: "", description: "", debitAcct: "", debit: "", creditAcct: "", credit: "" },
      ],
    }));
  }
  function removeRow(kind: BookKind, key: number) {
    setBookRows((prev) => ({ ...prev, [kind]: prev[kind].filter((r) => r.key !== key) }));
  }

  /** นำทางไปช่วงวันใหม่ (คง customer + เล่มที่เลือกอยู่) */
  function pushRange(from: string, to: string) {
    const params = new URLSearchParams();
    params.set("customer", customerId);
    params.set("from", from);
    params.set("to", to);
    if (book !== "all") params.set("book", book);
    router.push(`/chat-audit/accounting/journal-books?${params.toString()}`);
  }

  // ★ 2026-09-02 ผู้ใช้: ช่วงหลายเดือน (ทั้งเดือนนี้ → ถึงเดือนนี้) + ปุ่มดึงข้อมูล
  //   (เมนู "ทั้งเดือน" เดือนเดียวแบบเด้งทันที ผู้ใช้สั่งเอาออก — ใช้ช่วงเดือนแทน)
  const [rangeStart, setRangeStart] = useState(selectedMonth);
  const [rangeEnd, setRangeEnd] = useState(selectedMonth);
  function lastDayOf(month: string): string {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y ?? 0, m ?? 0, 0)).getUTCDate();
    return `${month}-${String(last).padStart(2, "0")}`;
  }
  function applyMonthRange() {
    const [a, b] = rangeStart <= rangeEnd ? [rangeStart, rangeEnd] : [rangeEnd, rangeStart];
    if (!/^\d{4}-\d{2}$/.test(a) || !/^\d{4}-\d{2}$/.test(b)) return;
    pushRange(`${a}-01`, lastDayOf(b));
  }

  // ---- Excel: ส่งค่าที่แก้บนจอไป POST → server สร้าง .xlsx ให้ตรงที่เห็น ----
  const [excelBusy, setExcelBusy] = useState(false);
  const [excelErr, setExcelErr] = useState<string | null>(null);
  async function onExportExcel() {
    setExcelErr(null);
    setExcelBusy(true);
    try {
      const payload = {
        customer: customerId,
        from: fromDate,
        to: toDate,
        book, // เล่มที่เลือก (all/kind) — server จะ export เฉพาะเล่มที่เห็น
        books: BOOK_ORDER.map((kind) => ({
          kind,
          rows: bookRows[kind].map((r) => ({
            dateText: r.dateText,
            docNo: r.docNo,
            description: r.description,
            debitAcct: r.debitAcct,
            debit: r.debit.trim() ? parseAmountInput(r.debit) : null,
            creditAcct: r.creditAcct,
            credit: r.credit.trim() ? parseAmountInput(r.credit) : null,
          })),
        })),
      };
      const err = await downloadExcelFromPost(
        "/chat-audit/accounting/journal-books/export",
        payload,
        "journal-books.xlsx"
      );
      if (err) setExcelErr(err);
    } finally {
      setExcelBusy(false);
    }
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
        {/* ★ 2026-09-02 ผู้ใช้: เมนู "ทั้งเดือน" (เดือนเดียว เด้งทันที) เอาออก — เหลือช่วงเดือน+ปุ่มดึงข้อมูล
            เลือกเดือนเดียว = ตั้งช่วงเดือนเริ่ม/จบเป็นเดือนเดียวกันแล้วกดดึง */}
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
          title="ดึงรายการของช่วงเดือนที่เลือก"
        >
          📥 ดึงข้อมูล
        </button>
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
        <span className="vr-toolbar-hint">
          แก้ตัวเลข/ข้อความในตารางได้ แล้วพิมพ์/บันทึก PDF หรือ Excel (ทั้งพิมพ์และ Excel = ตามที่แก้บนจอ)
        </span>
        <button
          type="button"
          className="vr-btn vr-btn-ghost"
          onClick={onExportExcel}
          disabled={excelBusy}
          title="ออก Excel ตามค่าที่แก้บนจอ"
        >
          {excelBusy ? "กำลังสร้าง…" : "⬇ Excel"}
        </button>
        <button type="button" className="vr-btn vr-btn-primary" onClick={() => window.print()}>
          🖨 พิมพ์ / บันทึก PDF
        </button>
        {excelErr && <span className="vr-save-err">{excelErr}</span>}
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

        {/* ข้อความเตือน (ซ่อนตอนพิมพ์): แก้ในหน้านี้ไม่กระทบข้อมูลบิลจริง */}
        <div className="vr-editnote no-print" style={{ marginBottom: 10 }}>
          การแก้ในหน้านี้ใช้เฉพาะตอนพิมพ์/ออก Excel เท่านั้น — ไม่กระทบข้อมูลบิลจริง
          (ต้องการแก้ข้อมูลจริงให้ไปที่ “ตรวจ/แก้” ที่บิล)
        </div>

        {shownBooks.map((kind) => (
          <BookSection
            key={kind}
            label={BOOK_LABELS[kind]}
            rows={bookRows[kind]}
            totals={bookTotals[kind]}
            onUpdate={(key, patch) => updateRow(kind, key, patch)}
            onAdd={() => addRow(kind)}
            onRemove={(key) => removeRow(kind, key)}
          />
        ))}

      </div>
    </div>
  );
}

/** 1 เล่ม = หัวข้อ + ตารางแก้ได้ + แถวรวม (ขึ้นหน้าใหม่ตอนพิมพ์) */
function BookSection({
  label,
  rows,
  totals,
  onUpdate,
  onAdd,
  onRemove,
}: {
  label: string;
  rows: JbEditRow[];
  totals: { debit: number; credit: number; docs: number };
  onUpdate: (key: number, patch: Partial<JbEditRow>) => void;
  onAdd: () => void;
  onRemove: (key: number) => void;
}) {
  return (
    <section className="jb-book">
      <h2 className="jb-book-title">{label}</h2>
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
            <th className="vr-col-del no-print" aria-label="ลบ" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="vr-empty">ไม่มีรายการในเล่มนี้ — กด “＋ เพิ่มบรรทัด” เพื่อพิมพ์เพิ่มได้</td>
              <td className="vr-col-del no-print" />
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={r.key}>
                <td className="jb-c-date">
                  <input
                    className="vr-in vr-cell vr-cell-center"
                    value={r.dateText}
                    onChange={(e) => onUpdate(r.key, { dateText: e.target.value })}
                    placeholder="วว/ดด/ปปปป"
                    aria-label={`วันที่บรรทัดที่ ${i + 1}`}
                  />
                </td>
                <td className="jb-c-no">
                  <input
                    className="vr-in vr-cell vr-cell-center"
                    value={r.docNo}
                    onChange={(e) => onUpdate(r.key, { docNo: e.target.value })}
                    aria-label={`เลขที่บรรทัดที่ ${i + 1}`}
                  />
                </td>
                <td className="jb-c-desc">
                  <input
                    className="vr-in vr-cell"
                    value={r.description}
                    onChange={(e) => onUpdate(r.key, { description: e.target.value })}
                    aria-label={`คำอธิบายบรรทัดที่ ${i + 1}`}
                  />
                </td>
                <td className="jb-c-acct">
                  <input
                    className="vr-in vr-cell"
                    value={r.debitAcct}
                    onChange={(e) => onUpdate(r.key, { debitAcct: e.target.value })}
                    aria-label={`บัญชีเดบิตบรรทัดที่ ${i + 1}`}
                  />
                </td>
                <td className="vr-c-money">
                  <input
                    className="vr-in vr-cell vr-cell-money"
                    value={r.debit}
                    onChange={(e) => onUpdate(r.key, { debit: e.target.value })}
                    inputMode="decimal"
                    placeholder=""
                    aria-label={`เดบิตบรรทัดที่ ${i + 1}`}
                  />
                </td>
                <td className="jb-c-acct jb-c-credit">
                  <input
                    className="vr-in vr-cell"
                    value={r.creditAcct}
                    onChange={(e) => onUpdate(r.key, { creditAcct: e.target.value })}
                    aria-label={`บัญชีเครดิตบรรทัดที่ ${i + 1}`}
                  />
                </td>
                <td className="vr-c-money">
                  <input
                    className="vr-in vr-cell vr-cell-money"
                    value={r.credit}
                    onChange={(e) => onUpdate(r.key, { credit: e.target.value })}
                    inputMode="decimal"
                    placeholder=""
                    aria-label={`เครดิตบรรทัดที่ ${i + 1}`}
                  />
                </td>
                <td className="vr-col-del no-print">
                  <button
                    type="button"
                    className="vr-row-del"
                    onClick={() => onRemove(r.key)}
                    aria-label="ลบบรรทัด"
                    title="ลบบรรทัด"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="vr-total">
            <td colSpan={4} className="vr-total-label">
              รวม {totals.docs.toLocaleString("th-TH")} รายการ
            </td>
            <td className="vr-c-money">{formatMoney(totals.debit)}</td>
            <td />
            <td className="vr-c-money">{formatMoney(totals.credit)}</td>
            <td className="vr-col-del no-print" />
          </tr>
        </tfoot>
      </table>

      {/* ปุ่มเพิ่มบรรทัด (ซ่อนตอนพิมพ์) */}
      <div className="vr-addrow-wrap no-print">
        <button type="button" className="vr-btn vr-btn-ghost vr-btn-sm" onClick={onAdd}>
          ＋ เพิ่มบรรทัด
        </button>
      </div>
    </section>
  );
}
