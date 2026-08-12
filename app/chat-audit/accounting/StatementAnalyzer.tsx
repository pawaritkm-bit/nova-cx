"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { createStatementUploadUrlAction } from "./statement-actions";
import { createClient as createBrowserSupabase } from "@/lib/supabase/client";
import { UPLOAD_ACCEPT, MAX_UPLOAD_BYTES, validateUpload } from "@/lib/accounting/upload";
import {
  summarizeByMonth,
  findRepeatCounterparties,
  type StatementTxn,
  type TxnDirection,
} from "@/lib/accounting/statement-analyze";

/** bucket เดียวกับบิล (ต้องตรงกับ STATEMENT actions / route) */
const BILLS_BUCKET = "bills";

/** ★ 2026-08-12 — จำนวนไฟล์สูงสุดต่อครั้ง (กันยิง AI พร้อมกันมากเกินจนค่าใช้จ่าย/เวลาควบคุมไม่ได้) */
const MAX_FILES = 10;
/** จำนวนไฟล์ที่ประมวลผลพร้อมกันสูงสุด (แต่ละไฟล์ก็ยิง AI หลายชุดพร้อมกันอยู่แล้วฝั่ง server —
 *  คุมจำนวนไฟล์ที่ทำพร้อมกันด้วยเพื่อไม่ให้ยอดรวม concurrent request ไป OpenAI พุ่งเกินควร) */
const FILE_CONCURRENCY = 3;

type StatementMeta = {
  totalRows: number;
  includedRows: number;
  truncated: boolean;
  chunkCount: number;
  failedChunks: number;
} | null;

/** ผลลัพธ์ของไฟล์เดียว (อัปโหลด+อ่านเสร็จแล้ว) */
type FileResult = {
  fileName: string;
  ok: boolean;
  errorMessage?: string;
  transactions: StatementTxn[];
  meta: StatementMeta;
};

/** format ตัวเลขเป็นเงินไทย (ทศนิยม 2) */
function money(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** แปลงป้ายเดือน 'YYYY-MM' → 'เดือน ปีพ.ศ.' */
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
function monthLabel(m: string): string {
  const mm = /^(\d{4})-(\d{2})$/.exec(m);
  if (!mm) return "ไม่ระบุเดือน";
  return `${TH_MONTHS[Number(mm[2]) - 1] ?? mm[2]} ${Number(mm[1]) + 543}`;
}

/** รันงานแบบ concurrency-bounded (worker pool ง่าย ๆ) — คืนผลลัพธ์เรียงตามลำดับ input เดิม */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * แผง "AI แยกสเตทเมนต์ ขาเข้า-ขาออก" (client)
 *   1) เลือกไฟล์สเตทเมนต์ได้หลายไฟล์พร้อมกัน (PDF/รูป/Excel/CSV) → อัปตรงเข้า Storage (signed URL) ต่อไฟล์
 *      ★ 2026-08-12 — อัปโหลด/อ่านหลายไฟล์พร้อมกัน (bounded concurrency) แล้วรวมผลเป็นชุดเดียว
 *   2) เรียก /api/accounting/extract-statement ต่อไฟล์ → AI แยกธุรกรรม → รวมทุกไฟล์แล้วสรุปรายเดือน + คนโอนซ้ำ
 *   3) แสดงสถานะรายไฟล์ (สำเร็จ/ล้มเหลว/ตัดข้อมูล) + ตารางธุรกรรมรวม (แก้ได้) · การ์ดสรุปรายเดือน · ตารางคนโอนซ้ำ
 *      ★ แก้ตารางแล้ว การ์ด/คนโอนซ้ำคำนวณใหม่ทันที (ใช้ helper เดียวกับ server)
 */
export default function StatementAnalyzer({
  customerId,
  customerLabel,
}: {
  customerId: string;
  customerLabel: string;
}) {
  const [pending, startTransition] = useTransition();
  const [phase, setPhase] = useState<"" | "reading">("");
  const [err, setErr] = useState<string | null>(null);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [txns, setTxns] = useState<StatementTxn[]>([]);
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // สรุปรายเดือน + คนโอนซ้ำ คำนวณใหม่ทุกครั้งที่ตารางเปลี่ยน (helper เดียวกับ server) — รวมทุกไฟล์แล้ว
  const monthly = useMemo(() => summarizeByMonth(txns), [txns]);
  const repeats = useMemo(() => findRepeatCounterparties(txns), [txns]);
  const repeatIn = repeats.filter((r) => r.direction === "in");
  const repeatOut = repeats.filter((r) => r.direction === "out");

  function updateTxn(idx: number, patch: Partial<StatementTxn>) {
    setTxns((prev) => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  }

  /** อัปโหลด + อ่านไฟล์เดียวจบ (1 ไฟล์ = 1 signed URL + 1 เรียก extract-statement) */
  async function processOneFile(file: File): Promise<FileResult> {
    const prep = await createStatementUploadUrlAction({
      customerId,
      fileName: file.name,
      mime: file.type,
      size: file.size,
    });
    if (!prep.ok) {
      return { fileName: file.name, ok: false, errorMessage: prep.message, transactions: [], meta: null };
    }

    try {
      const supabase = createBrowserSupabase();
      const { error: upErr } = await supabase.storage
        .from(BILLS_BUCKET)
        .uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type || undefined });
      if (upErr) {
        return {
          fileName: file.name,
          ok: false,
          errorMessage: `อัปโหลดไฟล์ไม่สำเร็จ: ${upErr.message || "กรุณาลองใหม่"}`,
          transactions: [],
          meta: null,
        };
      }
    } catch {
      return { fileName: file.name, ok: false, errorMessage: "อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่", transactions: [], meta: null };
    }

    try {
      const res = await fetch("/api/accounting/extract-statement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: prep.path, customerId, fileName: file.name }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; transactions?: StatementTxn[]; meta?: StatementMeta }
        | null;
      if (!res.ok || !data?.ok) {
        return { fileName: file.name, ok: false, errorMessage: "อ่านสเตทเมนต์ไม่สำเร็จ กรุณาลองใหม่", transactions: [], meta: null };
      }
      return {
        fileName: file.name,
        ok: true,
        transactions: Array.isArray(data.transactions) ? data.transactions : [],
        meta: data.meta ?? null,
      };
    } catch {
      return { fileName: file.name, ok: false, errorMessage: "อ่านสเตทเมนต์ไม่สำเร็จ กรุณาลองใหม่", transactions: [], meta: null };
    }
  }

  function submit() {
    const files = fileRef.current?.files ? Array.from(fileRef.current.files) : [];
    if (files.length === 0) {
      setErr("กรุณาเลือกไฟล์สเตทเมนต์อย่างน้อย 1 ไฟล์");
      return;
    }
    if (files.length > MAX_FILES) {
      setErr(`อัปโหลดได้ไม่เกิน ${MAX_FILES} ไฟล์ต่อครั้ง (เลือกไว้ ${files.length} ไฟล์)`);
      return;
    }
    for (const f of files) {
      const v = validateUpload({ mime: f.type, name: f.name, size: f.size });
      if (!v.ok) {
        setErr(`${f.name}: ${v.error}`);
        return;
      }
    }
    setErr(null);
    setDone(false);
    setFileResults([]);

    startTransition(async () => {
      setPhase("reading");
      const results = await mapWithConcurrency(files, FILE_CONCURRENCY, (f) => processOneFile(f));
      setFileResults(results);
      setTxns(results.filter((r) => r.ok).flatMap((r) => r.transactions));
      setDone(true);
      setPhase("");
    });
  }

  const successCount = fileResults.filter((r) => r.ok).length;
  const hasAnyIssue = fileResults.some((r) => !r.ok || r.meta?.truncated || (r.meta?.failedChunks ?? 0) > 0);

  return (
    <div className="stmt-panel">
      {/* แถบอัปโหลด */}
      <div className="stmt-upload-bar">
        <div className="stmt-upload-cust">{customerLabel}</div>
        <input
          ref={fileRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          multiple
          disabled={pending}
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            setErr(null);
            const oversize = files.find((f) => f.size > MAX_UPLOAD_BYTES);
            if (oversize) {
              setErr(`${oversize.name}: ไฟล์ใหญ่เกิน 50MB`);
              setSelectedNames([]);
              return;
            }
            if (files.length > MAX_FILES) {
              setErr(`อัปโหลดได้ไม่เกิน ${MAX_FILES} ไฟล์ต่อครั้ง (เลือกไว้ ${files.length} ไฟล์)`);
            }
            setSelectedNames(files.map((f) => f.name));
          }}
        />
        <button type="button" className="btn" onClick={submit} disabled={pending}>
          {phase === "reading" ? "กำลังอัปโหลด + AI กำลังอ่าน…" : "อัปสเตทเมนต์ + แยกรายการ"}
        </button>
      </div>
      {selectedNames.length > 0 ? (
        <div className="stmt-fname">
          เลือกไว้ {selectedNames.length} ไฟล์: {selectedNames.join(", ")}
        </div>
      ) : null}
      {err ? <div className="action-msg err">{err}</div> : null}

      {phase === "reading" ? (
        <div className="stmt-reading">
          AI กำลังอ่านสเตทเมนต์ {selectedNames.length > 1 ? `ทั้ง ${selectedNames.length} ไฟล์` : ""}และแยกรายการเข้า/ออก…
          (ไฟล์ยาว/หลายไฟล์อาจใช้เวลาสักครู่)
        </div>
      ) : null}

      {/* ★ 2026-08-12 — สถานะรายไฟล์ (สำเร็จ/ล้มเหลว/ตัดข้อมูล/ชุดล้มเหลวบางส่วน) */}
      {done && fileResults.length > 0 ? (
        <section className="stmt-section">
          <h3 className="stmt-h">
            สถานะไฟล์ ({successCount}/{fileResults.length} สำเร็จ)
          </h3>
          <ul className="stmt-file-status-list">
            {fileResults.map((r, i) => (
              <li key={i} className={r.ok ? "ok" : "err"}>
                <b>{r.fileName}</b>{" "}
                {!r.ok ? (
                  <span>— ล้มเหลว: {r.errorMessage ?? "ไม่ทราบสาเหตุ"}</span>
                ) : r.meta?.truncated ? (
                  <span>
                    — อ่าน {r.transactions.length.toLocaleString("th-TH")} รายการ (ไฟล์ใหญ่เกินประมวลผลได้ในครั้งเดียว —
                    อ่านไป {r.meta.includedRows.toLocaleString("th-TH")} จาก {r.meta.totalRows.toLocaleString("th-TH")} แถว
                    ลองแบ่งไฟล์เป็นช่วงเวลาสั้นลง)
                  </span>
                ) : r.meta && r.meta.failedChunks > 0 ? (
                  <span>
                    — อ่านได้บางส่วน ({r.meta.chunkCount - r.meta.failedChunks}/{r.meta.chunkCount} ชุดสำเร็จ) ลองอัปโหลด
                    ไฟล์นี้ใหม่อีกครั้ง
                  </span>
                ) : r.transactions.length === 0 ? (
                  <span>— อ่านไม่พบรายการธุรกรรม</span>
                ) : (
                  <span>— อ่านสำเร็จ {r.transactions.length.toLocaleString("th-TH")} รายการ</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {done && txns.length === 0 && !hasAnyIssue ? (
        <div className="card"><p className="empty">อ่านไม่พบรายการธุรกรรม ลองไฟล์อื่น หรือตรวจว่าเป็นสเตทเมนต์จริง</p></div>
      ) : null}

      {txns.length > 0 ? (
        <>
          {/* การ์ดสรุปรายเดือน (รวมทุกไฟล์) */}
          <section className="stmt-section">
            <h3 className="stmt-h">สรุปรายเดือน{fileResults.length > 1 ? " (รวมทุกไฟล์)" : ""}</h3>
            <div className="stmt-month-cards">
              {monthly.map((m) => (
                <div key={m.month || "none"} className="stmt-month-card">
                  <div className="stmt-month-title">{monthLabel(m.month)}</div>
                  <div className="stmt-month-row in">
                    <span>เงินเข้า ({m.inCount})</span>
                    <b>{money(m.inTotal)}</b>
                  </div>
                  <div className="stmt-month-row out">
                    <span>เงินออก ({m.outCount})</span>
                    <b>{money(m.outTotal)}</b>
                  </div>
                  <div className="stmt-month-net">
                    <span>คงเหลือสุทธิ</span>
                    <b>{money(m.inTotal - m.outTotal)}</b>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ตารางคนโอนซ้ำ (รวมทุกไฟล์ — จับคู่ข้ามไฟล์ได้ด้วย เช่นลูกค้าประจำที่โอนเข้ามาในหลายเดือน/หลายไฟล์) */}
          {repeatIn.length > 0 || repeatOut.length > 0 ? (
            <section className="stmt-section">
              <h3 className="stmt-h">คนที่โอนซ้ำ (ตั้งแต่ 2 ครั้งขึ้นไป){fileResults.length > 1 ? " (รวมทุกไฟล์)" : ""}</h3>
              <div className="stmt-repeat-grid">
                <RepeatTable title="โอนเข้าซ้ำ (ลูกค้าประจำ?)" rows={repeatIn} tone="in" />
                <RepeatTable title="โอนออกซ้ำ (จ่ายประจำ?)" rows={repeatOut} tone="out" />
              </div>
            </section>
          ) : null}

          {/* ตารางธุรกรรม (แก้ได้) */}
          <section className="stmt-section">
            <h3 className="stmt-h">รายการธุรกรรม ({txns.length}) — แก้ได้</h3>
            <div className="stmt-table-wrap">
              <table className="stmt-table">
                <thead>
                  <tr>
                    <th>วันที่</th>
                    <th>รายละเอียด</th>
                    <th>คู่ค้า</th>
                    <th>เลขบัญชี</th>
                    <th>ทิศทาง</th>
                    <th className="num">ยอดเงิน</th>
                  </tr>
                </thead>
                <tbody>
                  {txns.map((t, i) => (
                    <tr key={i} className={t.direction === "in" ? "in" : t.direction === "out" ? "out" : ""}>
                      <td>
                        <input
                          type="text"
                          value={t.date ?? ""}
                          placeholder="YYYY-MM-DD"
                          onChange={(e) => updateTxn(i, { date: e.target.value || null })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={t.description ?? ""}
                          onChange={(e) => updateTxn(i, { description: e.target.value || null })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={t.counterparty_name ?? ""}
                          onChange={(e) => updateTxn(i, { counterparty_name: e.target.value || null })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={t.counterparty_account_no ?? ""}
                          onChange={(e) => updateTxn(i, { counterparty_account_no: e.target.value || null })}
                        />
                      </td>
                      <td>
                        <select
                          value={t.direction ?? ""}
                          onChange={(e) => updateTxn(i, { direction: (e.target.value || null) as TxnDirection | null })}
                        >
                          <option value="">—</option>
                          <option value="in">เข้า</option>
                          <option value="out">ออก</option>
                        </select>
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          step="0.01"
                          value={t.amount ?? ""}
                          onChange={(e) => {
                            const n = e.target.value === "" ? null : Number(e.target.value);
                            updateTxn(i, { amount: n != null && Number.isFinite(n) ? n : null });
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="stmt-note">
              Phase 1: ผลนี้ยังไม่บันทึกลงระบบบัญชี (ดู/สรุป/จับคู่ซ้ำเท่านั้น) — โหลดใหม่แล้วข้อมูลจะหาย
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}

/** ตารางคนโอนซ้ำ (ต่อทิศทาง) */
function RepeatTable({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: { name: string; accountNo: string | null; count: number; total: number }[];
  tone: "in" | "out";
}) {
  if (rows.length === 0) {
    return (
      <div className="stmt-repeat-col">
        <div className={`stmt-repeat-title ${tone}`}>{title}</div>
        <p className="empty">ไม่พบคนที่โอนซ้ำ</p>
      </div>
    );
  }
  return (
    <div className="stmt-repeat-col">
      <div className={`stmt-repeat-title ${tone}`}>{title}</div>
      <table className="stmt-table">
        <thead>
          <tr>
            <th>ชื่อ</th>
            <th>เลขบัญชี</th>
            <th className="num">ครั้ง</th>
            <th className="num">ยอดรวม</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.name}</td>
              <td>{r.accountNo ?? "—"}</td>
              <td className="num">{r.count}</td>
              <td className="num">{money(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
