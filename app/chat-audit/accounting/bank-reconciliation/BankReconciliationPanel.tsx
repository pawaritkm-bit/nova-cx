"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  importCsvAction,
  addManualLineAction,
  deleteStatementLineAction,
  deleteBatchAction,
  confirmMatchAction,
  unmatchAction,
} from "./actions";
import { STATEMENT_CSV_TEMPLATE, isMatchStale, type BookLine, type BankStatementLine, type SuggestedMatch, type ReconciliationSummary, type ImportBatch } from "@/lib/accounting/bank-reconciliation";
import { formatMoney, parseAmountInput } from "@/lib/accounting/calc";

/**
 * BankReconciliationPanel — client component ของหน้า "กระทบยอดธนาคาร" (เฟส 6 ส่วน T, T52)
 *   - อัปโหลด CSV (+ ปุ่มดาวน์โหลด template ตัวอย่าง) / กรอกมือ
 *   - 2 คอลัมน์: book lines (ฝั่งบัญชี) / statement lines (ฝั่ง statement ธนาคาร)
 *   - คู่ที่ระบบแนะนำ — กดยืนยันทีละคู่เท่านั้น (0.17 ไม่ auto-confirm)
 *   - badge เตือน "รายการต้นทางอาจเปลี่ยนไปแล้ว" เมื่อ snapshot ไม่ตรงกับ book line ที่ re-compute สด (0.16)
 *   - สรุปยอด book/statement/ผลต่างที่ยังไม่จับคู่ (0.18 — ไม่มีปุ่มสร้าง manual JE อัตโนมัติจากผลต่าง)
 */
export default function BankReconciliationPanel({
  customerId,
  bankAccountId,
  month,
  includeDraft,
  bookLines,
  statementLines,
  suggestions,
  summary,
  batches,
}: {
  customerId: string;
  bankAccountId: string;
  accountCode: string;
  month: string;
  includeDraft: boolean;
  bookLines: BookLine[];
  statementLines: BankStatementLine[];
  suggestions: SuggestedMatch[];
  summary: ReconciliationSummary;
  batches: ImportBatch[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // กรอกมือ
  const [manualDate, setManualDate] = useState("");
  const [manualDesc, setManualDesc] = useState("");
  const [manualAmountText, setManualAmountText] = useState("");
  const [manualDirection, setManualDirection] = useState<"in" | "out">("in");

  const bookLinesByKey = useMemo(() => new Map(bookLines.map((b) => [b.key, b])), [bookLines]);
  const matchedBookKeys = useMemo(
    () => new Set(statementLines.filter((s) => s.matchedBookLineKey).map((s) => s.matchedBookLineKey as string)),
    [statementLines]
  );

  function downloadTemplate() {
    const blob = new Blob([STATEMENT_CSV_TEMPLATE], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bank-statement-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function submitCsv() {
    const file = fileRef.current?.files?.[0] ?? null;
    if (!file) {
      setMsg({ ok: false, text: "กรุณาเลือกไฟล์ CSV ก่อน" });
      return;
    }
    setMsg(null);
    const reader = new FileReader();
    reader.onload = () => {
      const csvText = typeof reader.result === "string" ? reader.result : "";
      startTransition(async () => {
        const res = await importCsvAction({ customerId, bankAccountId, fileName: file.name, csvText });
        setMsg({ ok: res.ok, text: res.ok ? (res.message ?? "นำเข้าสำเร็จ") : res.message });
        if (res.ok) {
          if (fileRef.current) fileRef.current.value = "";
          router.refresh();
        }
      });
    };
    reader.onerror = () => setMsg({ ok: false, text: "อ่านไฟล์ไม่สำเร็จ กรุณาลองใหม่" });
    reader.readAsText(file, "utf-8");
  }

  function submitManual() {
    setMsg(null);
    const raw = parseAmountInput(manualAmountText);
    if (!raw) {
      setMsg({ ok: false, text: "กรุณาระบุจำนวนเงิน" });
      return;
    }
    const amount = manualDirection === "in" ? Math.abs(raw) : -Math.abs(raw);
    startTransition(async () => {
      const res = await addManualLineAction({
        customerId,
        bankAccountId,
        date: manualDate,
        description: manualDesc,
        amount,
      });
      setMsg({ ok: res.ok, text: res.ok ? "เพิ่มรายการแล้ว" : res.message });
      if (res.ok) {
        setManualDate("");
        setManualDesc("");
        setManualAmountText("");
        router.refresh();
      }
    });
  }

  function removeLine(lineId: string) {
    if (!window.confirm("ลบรายการนี้?")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteStatementLineAction(lineId, customerId);
      setMsg({ ok: res.ok, text: res.ok ? "ลบรายการแล้ว" : res.message });
      if (res.ok) router.refresh();
    });
  }

  function removeBatch(batchId: string, lineCount: number) {
    if (!window.confirm(`ลบชุดที่นำเข้านี้ทั้งหมด (${lineCount} รายการ)? ย้อนกลับไม่ได้`)) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteBatchAction(batchId, customerId);
      setMsg({ ok: res.ok, text: res.ok ? "ลบชุดที่นำเข้าแล้ว" : res.message });
      if (res.ok) router.refresh();
    });
  }

  function confirmSuggestion(s: SuggestedMatch) {
    setMsg(null);
    startTransition(async () => {
      const res = await confirmMatchAction({
        customerId,
        bankAccountId,
        statementLineId: s.statementLine.id,
        bookLineKey: s.bookLine.key,
        month,
        includeDraft,
      });
      setMsg({ ok: res.ok, text: res.ok ? "ยืนยันจับคู่แล้ว" : res.message });
      if (res.ok) router.refresh();
    });
  }

  function doUnmatch(lineId: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await unmatchAction(lineId, customerId, bankAccountId);
      setMsg({ ok: res.ok, text: res.ok ? "ยกเลิกจับคู่แล้ว" : res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="acc-je">
      {/* นำเข้า CSV + กรอกมือ */}
      <div className="card">
        <div className="strong" style={{ marginBottom: 8 }}>นำเข้า statement ธนาคาร</div>
        <div className="acc-bankrec-import-row">
          <input ref={fileRef} type="file" accept=".csv,text/csv" disabled={pending} />
          <button type="button" className="btn" onClick={submitCsv} disabled={pending}>
            {pending ? "กำลังนำเข้า…" : "นำเข้า CSV"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={downloadTemplate}>
            ⬇ ดาวน์โหลด template ตัวอย่าง
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          ไฟล์ CSV ต้องมี 3 คอลัมน์ตามลำดับ: date (YYYY-MM-DD), description, amount (+ เงินเข้า / − เงินออก)
        </p>

        {batches.length > 0 ? (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>ไฟล์</th>
                  <th className="num">จำนวนแถว</th>
                  <th>นำเข้าเมื่อ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>{b.fileName ?? "(ไม่ระบุชื่อไฟล์)"}</td>
                    <td className="num">{b.lineCount}</td>
                    <td>{new Date(b.importedAt).toLocaleString("th-TH")}</td>
                    <td>
                      <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => removeBatch(b.id, b.lineCount)}>
                        ลบชุดนี้
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="strong" style={{ marginTop: 16, marginBottom: 8 }}>กรอกรายการ statement เอง</div>
        <div className="acc-bankrec-manual-row">
          <label className="acc-field">
            <span>วันที่</span>
            <input type="date" value={manualDate} onChange={(e) => setManualDate(e.target.value)} disabled={pending} />
          </label>
          <label className="acc-field acc-field-wide">
            <span>คำอธิบาย</span>
            <input type="text" value={manualDesc} onChange={(e) => setManualDesc(e.target.value)} disabled={pending} maxLength={200} />
          </label>
          <label className="acc-field">
            <span>ประเภท</span>
            <select value={manualDirection} onChange={(e) => setManualDirection(e.target.value as "in" | "out")} disabled={pending}>
              <option value="in">เงินเข้า (+)</option>
              <option value="out">เงินออก (−)</option>
            </select>
          </label>
          <label className="acc-field">
            <span>จำนวนเงิน</span>
            <input type="text" inputMode="decimal" value={manualAmountText} onChange={(e) => setManualAmountText(e.target.value)} placeholder="0.00" disabled={pending} />
          </label>
          <button type="button" className="btn" onClick={submitManual} disabled={pending}>เพิ่มรายการ</button>
        </div>

        {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`} style={{ marginTop: 8 }}>{msg.text}</div> : null}
      </div>

      {/* คู่ที่ระบบแนะนำ (0.17) */}
      <div className="card">
        <div className="strong" style={{ marginBottom: 8 }}>คู่ที่ระบบแนะนำให้จับคู่ ({suggestions.length})</div>
        {suggestions.length === 0 ? (
          <p className="empty">ไม่มีคู่ที่แนะนำในตอนนี้ (ยอด/วันที่ยังไม่ตรงกัน หรือจับคู่ครบแล้ว)</p>
        ) : (
          <div className="table-wrap">
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>ฝั่งบัญชี</th>
                  <th className="num">ยอดบัญชี</th>
                  <th>ฝั่ง statement</th>
                  <th className="num">ยอด statement</th>
                  <th className="num">ห่างกัน (วัน)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s, idx) => (
                  <tr key={`${s.bookLine.key}:${s.statementLine.id}`}>
                    <td>{s.bookLine.date} · {s.bookLine.docNo ?? ""} {s.bookLine.counterparty ?? ""}</td>
                    <td className="num">{formatMoney(s.bookLine.amount)}</td>
                    <td>{s.statementLine.date} · {s.statementLine.description ?? ""}</td>
                    <td className="num">{formatMoney(s.statementLine.amount)}</td>
                    <td className="num">{s.daysApart}</td>
                    <td>
                      <button type="button" className="btn" disabled={pending} onClick={() => confirmSuggestion(s)}>
                        ยืนยันจับคู่
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 2 คอลัมน์ — book vs statement */}
      <div className="acc-bankrec-columns">
        <div className="card">
          <div className="strong" style={{ marginBottom: 8 }}>ฝั่งบัญชี (book) — {bookLines.length} รายการ</div>
          <div className="table-wrap">
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>เอกสาร/คู่ค้า</th>
                  <th className="num">จำนวนเงิน</th>
                  <th>สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {bookLines.map((b) => {
                  const matched = matchedBookKeys.has(b.key);
                  return (
                    <tr key={b.key}>
                      <td>{b.date ?? "-"}</td>
                      <td>{b.docNo ?? ""} {b.counterparty ?? ""}</td>
                      <td className="num">{formatMoney(b.amount)}</td>
                      <td>{matched ? <span className="fa-sync-badge fa-sync-badge-ok">จับคู่แล้ว</span> : <span className="muted">ยังไม่จับคู่</span>}</td>
                    </tr>
                  );
                })}
                {bookLines.length === 0 ? (
                  <tr><td colSpan={4} className="empty">ไม่มีรายการฝั่งบัญชีในงวดนี้</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="strong" style={{ marginBottom: 8 }}>ฝั่ง statement ธนาคาร — {statementLines.length} รายการ</div>
          <div className="table-wrap">
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>คำอธิบาย</th>
                  <th className="num">จำนวนเงิน</th>
                  <th>สถานะ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {statementLines.map((s) => {
                  const matched = !!s.matchedBookLineKey;
                  const stale = matched && isMatchStale(s, bookLinesByKey);
                  return (
                    <tr key={s.id}>
                      <td>{s.date}</td>
                      <td>{s.description ?? ""}</td>
                      <td className="num">{formatMoney(s.amount)}</td>
                      <td>
                        {matched ? (
                          <span className="fa-sync-badge fa-sync-badge-ok">จับคู่แล้ว</span>
                        ) : (
                          <span className="muted">ยังไม่จับคู่</span>
                        )}
                        {stale ? (
                          <div>
                            <span className="fa-sync-badge fa-sync-badge-warn">
                              รายการต้นทางอาจเปลี่ยนไปแล้ว — ตรวจสอบใหม่
                            </span>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {matched ? (
                          <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => doUnmatch(s.id)}>
                            ยกเลิกจับคู่
                          </button>
                        ) : (
                          <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => removeLine(s.id)}>
                            ลบ
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {statementLines.length === 0 ? (
                  <tr><td colSpan={5} className="empty">ยังไม่มีรายการ statement ในงวดนี้</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* สรุปยอด (0.18) */}
      <div className="card">
        <div className="strong" style={{ marginBottom: 8 }}>สรุปยอด</div>
        <div className="table-wrap">
          <table className="dlv-table acc-table">
            <tbody>
              <tr>
                <td>ยอดรวมฝั่งบัญชี (book balance)</td>
                <td className="num">{formatMoney(summary.bookBalance)}</td>
              </tr>
              <tr>
                <td>ยอดรวมฝั่ง statement ธนาคาร</td>
                <td className="num">{formatMoney(summary.statementBalance)}</td>
              </tr>
              <tr>
                <td>ยอดฝั่งบัญชีที่ยังไม่จับคู่ ({summary.unmatchedBookCount} รายการ)</td>
                <td className="num">{formatMoney(summary.unmatchedBookTotal)}</td>
              </tr>
              <tr>
                <td>ยอดฝั่ง statement ที่ยังไม่จับคู่ ({summary.unmatchedStatementCount} รายการ)</td>
                <td className="num">{formatMoney(summary.unmatchedStatementTotal)}</td>
              </tr>
              <tr className="acc-total">
                <td className="strong">ผลต่างที่ยังไม่จับคู่ (statement − book)</td>
                <td className="num strong">{formatMoney(summary.unmatchedDiff)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          พบผลต่าง (เช่น ค่าธรรมเนียมธนาคารที่ยังไม่ได้บันทึก)? ระบบไม่สร้างรายการปรับปรุงให้อัตโนมัติ — ไปบันทึกที่หน้า
          &ldquo;ลงบันทึกบัญชีเอง&rdquo; (JV/PV/RV) เอง (0.18)
        </p>
      </div>
    </div>
  );
}
