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

/**
 * แผง "AI แยกสเตทเมนต์ ขาเข้า-ขาออก" (client)
 *   1) เลือกไฟล์สเตทเมนต์ (PDF/รูป/Excel/CSV) → อัปตรงเข้า Storage (signed URL)
 *   2) เรียก /api/accounting/extract-statement → AI แยกธุรกรรม + สรุปรายเดือน + คนโอนซ้ำ
 *   3) แสดงตารางธุรกรรม (แก้ทิศทาง/ยอดได้) · การ์ดสรุปรายเดือน · ตารางคนโอนซ้ำ
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
  const [phase, setPhase] = useState<"" | "uploading" | "reading">("");
  const [err, setErr] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [done, setDone] = useState(false);
  const [txns, setTxns] = useState<StatementTxn[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // สรุปรายเดือน + คนโอนซ้ำ คำนวณใหม่ทุกครั้งที่ตารางเปลี่ยน (helper เดียวกับ server)
  const monthly = useMemo(() => summarizeByMonth(txns), [txns]);
  const repeats = useMemo(() => findRepeatCounterparties(txns), [txns]);
  const repeatIn = repeats.filter((r) => r.direction === "in");
  const repeatOut = repeats.filter((r) => r.direction === "out");

  function updateTxn(idx: number, patch: Partial<StatementTxn>) {
    setTxns((prev) => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  }

  function submit() {
    const file = fileRef.current?.files?.[0] ?? null;
    if (!file) {
      setErr("กรุณาเลือกไฟล์สเตทเมนต์ก่อน");
      return;
    }
    const v = validateUpload({ mime: file.type, name: file.name, size: file.size });
    if (!v.ok) {
      setErr(v.error);
      return;
    }
    setErr(null);
    setDone(false);

    startTransition(async () => {
      setPhase("uploading");

      // 1) ขอ signed upload URL
      const prep = await createStatementUploadUrlAction({
        customerId,
        fileName: file.name,
        mime: file.type,
        size: file.size,
      });
      if (!prep.ok) {
        setErr(prep.message);
        setPhase("");
        return;
      }

      // 2) อัปไฟล์ตรงเข้า Storage (ไฟล์ใหญ่ก็ผ่าน — ไม่วิ่งผ่าน serverless)
      try {
        const supabase = createBrowserSupabase();
        const { error: upErr } = await supabase.storage
          .from(BILLS_BUCKET)
          .uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type || undefined });
        if (upErr) {
          setErr(`อัปโหลดไฟล์ไม่สำเร็จ: ${upErr.message || "กรุณาลองใหม่"}`);
          setPhase("");
          return;
        }
      } catch {
        setErr("อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่");
        setPhase("");
        return;
      }

      // 3) AI อ่านสเตทเมนต์ (รอผล — Phase 1 ไม่ persist, ประมวลผล on-the-fly)
      setPhase("reading");
      try {
        const res = await fetch("/api/accounting/extract-statement", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: prep.path, customerId, fileName: file.name }),
        });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; transactions?: StatementTxn[] } | null;
        if (!res.ok || !data?.ok) {
          setErr("อ่านสเตทเมนต์ไม่สำเร็จ กรุณาลองใหม่");
          setPhase("");
          return;
        }
        setTxns(Array.isArray(data.transactions) ? data.transactions : []);
        setDone(true);
      } catch {
        setErr("อ่านสเตทเมนต์ไม่สำเร็จ กรุณาลองใหม่");
        setPhase("");
        return;
      }
      setPhase("");
    });
  }

  return (
    <div className="stmt-panel">
      {/* แถบอัปโหลด */}
      <div className="stmt-upload-bar">
        <div className="stmt-upload-cust">{customerLabel}</div>
        <input
          ref={fileRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          disabled={pending}
          onChange={(e) => {
            const f = e.target.files?.[0];
            setErr(null);
            if (f && f.size > MAX_UPLOAD_BYTES) {
              setErr("ไฟล์ใหญ่เกิน 50MB");
              setFileName("");
            } else {
              setFileName(f?.name ?? "");
            }
          }}
        />
        <button type="button" className="btn" onClick={submit} disabled={pending}>
          {phase === "uploading" ? "กำลังอัปโหลด…" : phase === "reading" ? "AI กำลังอ่าน…" : "อัปสเตทเมนต์ + แยกรายการ"}
        </button>
      </div>
      {fileName ? <div className="stmt-fname" title={fileName}>ไฟล์: {fileName}</div> : null}
      {err ? <div className="action-msg err">{err}</div> : null}

      {phase === "reading" ? (
        <div className="stmt-reading">AI กำลังอ่านสเตทเมนต์และแยกรายการเข้า/ออก… (ไฟล์ยาวอาจใช้เวลาสักครู่)</div>
      ) : null}

      {done && txns.length === 0 ? (
        <div className="card"><p className="empty">อ่านไม่พบรายการธุรกรรม ลองไฟล์อื่น หรือตรวจว่าเป็นสเตทเมนต์จริง</p></div>
      ) : null}

      {txns.length > 0 ? (
        <>
          {/* การ์ดสรุปรายเดือน */}
          <section className="stmt-section">
            <h3 className="stmt-h">สรุปรายเดือน</h3>
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

          {/* ตารางคนโอนซ้ำ */}
          {repeatIn.length > 0 || repeatOut.length > 0 ? (
            <section className="stmt-section">
              <h3 className="stmt-h">คนที่โอนซ้ำ (ตั้งแต่ 2 ครั้งขึ้นไป)</h3>
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
  rows: { name: string; count: number; total: number }[];
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
            <th className="num">ครั้ง</th>
            <th className="num">ยอดรวม</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.name}</td>
              <td className="num">{r.count}</td>
              <td className="num">{money(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
