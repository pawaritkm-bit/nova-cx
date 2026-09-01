"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  createStatementUploadUrlAction,
  createSaleBillsFromStatementAction,
  matchStatementWithBillsAction,
} from "./statement-actions";
import type { BillMatch, BillForMatch } from "@/lib/accounting/statement-bill-match";
import { createClient as createBrowserSupabase } from "@/lib/supabase/client";
import { UPLOAD_ACCEPT, MAX_UPLOAD_BYTES, validateUpload } from "@/lib/accounting/upload";
import {
  summarizeByMonth,
  findRepeatCounterparties,
  type StatementTxn,
  type TxnDirection,
} from "@/lib/accounting/statement-analyze";
import { toCsv } from "@/lib/accounting/csv-export";

/** bucket เดียวกับบิล (ต้องตรงกับ STATEMENT actions / route) */
const BILLS_BUCKET = "bills";

/** ★ 2026-08-12 — จำนวนไฟล์สูงสุดต่อ "รอบอัปโหลด" (กันยิง AI พร้อมกันมากเกินจนค่าใช้จ่าย/เวลาควบคุมไม่ได้)
 *  อัปได้หลายรอบต่อกัน — ผลลัพธ์แต่ละรอบจะถูกรวมเข้ากับรอบก่อนหน้า (ดู submit()) */
const MAX_FILES = 20;
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

/** ผลเซฟเข้าหน้ากระทบยอดธนาคารอัตโนมัติ (จาก route — best-effort) */
type ReconInfo = { imported: boolean; lineCount?: number; reason?: string } | null;

/** ผลลัพธ์ของไฟล์เดียว (อัปโหลด+อ่านเสร็จแล้ว) */
type FileResult = {
  fileName: string;
  ok: boolean;
  errorMessage?: string;
  transactions: StatementTxn[];
  meta: StatementMeta;
  recon?: ReconInfo;
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

/** สร้างไฟล์ CSV แล้วสั่งเบราว์เซอร์ดาวน์โหลดทันที (client-only — ไม่มี server round trip) */
function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
  // สร้างบิลขาย (ร่าง) จากเงินเข้า — requirement 2026-09-01
  const [billsMsg, setBillsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [creatingBills, setCreatingBills] = useState(false);
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [pdfPassword, setPdfPassword] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // กระทบกับบิลในระบบ (index ตรงกับ txns) — null ในช่อง = รายการนั้นไม่พบบิล · null ทั้งก้อน = ยังไม่ได้กระทบ
  const [matches, setMatches] = useState<(BillMatch | null)[] | null>(null);
  const [matching, setMatching] = useState(false);
  // บิลทั้งหมดของลูกค้า (จาก action เดียวกัน) — ใช้ช่อง "ค้นบิล" กรองฝั่ง client
  const [bills, setBills] = useState<BillForMatch[]>([]);
  // แถวที่ติ๊ก "ตรวจแล้ว" (client-side — เคลียร์เมื่อล้างรายการ)
  const [reviewed, setReviewed] = useState<Set<number>>(new Set());
  // จับคู่มือ (เลือกจากช่องค้นบิล) — override ผล auto ต่อแถว
  const [manualPick, setManualPick] = useState<Map<number, BillForMatch>>(new Map());
  // สร้างบิลขายรายแถว (index ที่กำลังสร้าง · -1 = ไม่มี)
  const [creatingRow, setCreatingRow] = useState<number>(-1);
  /** กระทบ txns ชุดที่ให้กับบิลของลูกค้า (เรียกอัตโนมัติหลังอ่าน/สร้างบิล + ปุ่ม manual) */
  const runBillMatch = useCallback(
    async (list: StatementTxn[]) => {
      if (list.length === 0) {
        setMatches(null);
        return;
      }
      setMatching(true);
      try {
        const r = await matchStatementWithBillsAction({ customerId, txns: list });
        setMatches(r.ok ? r.matches : null);
        if (r.ok) {
          setBills(r.bills);
          setManualPick(new Map()); // ผล auto ชุดใหม่ — ล้างการเลือกมือเดิม (อิง index ชุดเก่า)
        }
      } catch {
        setMatches(null);
      } finally {
        setMatching(false);
      }
    },
    [customerId]
  );

  /** สร้างบิลขาย (ร่าง) จากแถวเดียว — แถวเงินเข้าที่ไม่พบบิล */
  const createBillForRow = useCallback(
    (idx: number, t: StatementTxn, allTxns: StatementTxn[]) => {
      setCreatingRow(idx);
      createSaleBillsFromStatementAction({
        customerId,
        txns: [t],
        sourceLabel: "สเตทเมนต์ (จับคู่รายแถว)",
      })
        .then((r) => {
          setBillsMsg({ ok: r.ok, text: r.message });
          if (r.ok) void runBillMatch(allTxns);
        })
        .catch(() => setBillsMsg({ ok: false, text: "สร้างบิลไม่สำเร็จ กรุณาลองใหม่" }))
        .finally(() => setCreatingRow(-1));
    },
    [customerId, runBillMatch]
  );

  // flag "อ่าน/สร้างบิลเสร็จแล้ว รอกระทบกับบิล" — effect ยิงหลัง txns commit จริง (กัน stale closure)
  const wantMatchRef = useRef(false);
  useEffect(() => {
    if (!wantMatchRef.current) return;
    wantMatchRef.current = false;
    void runBillMatch(txns);
  }, [txns, runBillMatch]);

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
        body: JSON.stringify({ path: prep.path, customerId, fileName: file.name, password: pdfPassword || undefined }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; transactions?: StatementTxn[]; meta?: StatementMeta; message?: string; recon?: ReconInfo }
        | null;
      if (!res.ok || !data?.ok) {
        return {
          fileName: file.name,
          ok: false,
          errorMessage: data?.message ?? "อ่านสเตทเมนต์ไม่สำเร็จ กรุณาลองใหม่",
          transactions: [],
          meta: null,
        };
      }
      return {
        fileName: file.name,
        ok: true,
        transactions: Array.isArray(data.transactions) ? data.transactions : [],
        meta: data.meta ?? null,
        recon: data.recon ?? null,
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
      setErr(`อัปโหลดได้ไม่เกิน ${MAX_FILES} ไฟล์ต่อรอบ (เลือกไว้ ${files.length} ไฟล์) — แบ่งอัปหลายรอบได้ ระบบจะรวมผลให้`);
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

    startTransition(async () => {
      setPhase("reading");
      const results = await mapWithConcurrency(files, FILE_CONCURRENCY, (f) => processOneFile(f));
      // ★ 2026-08-12 — รวมผลรอบนี้เข้ากับรอบก่อนหน้า (ไม่ทับ) เพื่อรองรับอัปโหลดหลายรอบต่อกัน
      //   (เช่นมี 30+ ไฟล์ อัปทีละ 20 ได้ 2 รอบ — ผลรวมจะครบทุกไฟล์)
      setFileResults((prev) => [...prev, ...results]);
      // ★ functional update เสมอ (กัน state ค้างแบบบั๊กอัปโหลดข้ามลูกค้า 2026-09-01) — แล้วให้
      //   effect ด้านบนเห็น flag นี้ค่อยยิงกระทบกับบิลด้วย txns ล่าสุดจริง
      wantMatchRef.current = true;
      setTxns((prev) => [...prev, ...results.filter((r) => r.ok).flatMap((r) => r.transactions)]);
      setSelectedNames([]);
      if (fileRef.current) fileRef.current.value = "";
      setDone(true);
      setPhase("");
    });
  }

  function clearAll() {
    setFileResults([]);
    setTxns([]);
    setSelectedNames([]);
    setDone(false);
    setErr(null);
    setMatches(null);
    setReviewed(new Set());
    setManualPick(new Map());
    if (fileRef.current) fileRef.current.value = "";
  }

  /** ดาวน์โหลดตารางธุรกรรมที่แสดงอยู่ (รวมส่วนที่แก้ไขเองแล้ว) เป็น CSV — Phase 1 ไม่ persist ลง DB
   *  จึงต้อง export จากสิ่งที่แสดงบนจอตรง ๆ */
  function exportCsv() {
    const csv = toCsv(
      ["วันที่", "เวลา", "รายละเอียด", "คู่ค้า (ชื่อผู้โอน)", "เลขบัญชี", "ทิศทาง", "ยอดเงิน"],
      txns.map((t) => [
        t.date,
        t.time ?? "",
        t.description,
        t.counterparty_name,
        t.counterparty_account_no,
        t.direction === "in" ? "เข้า" : t.direction === "out" ? "ออก" : "",
        t.amount,
      ])
    );
    downloadCsv(`statement-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }

  const successCount = fileResults.filter((r) => r.ok).length;
  const hasAnyIssue = fileResults.some((r) => !r.ok || r.meta?.truncated || (r.meta?.failedChunks ?? 0) > 0);
  // ★ 2026-08-12 (พบจาก independent review) — เตือนถ้าไฟล์ที่เลือกรอบนี้ชื่อซ้ำกับไฟล์ที่อ่านสำเร็จไปแล้วในรอบก่อน
  //   (อัปหลายรอบแล้วรวมผลกัน — เลือกไฟล์เดิมซ้ำโดยไม่ตั้งใจจะทำให้ธุรกรรมถูกนับซ้ำสองรอบแบบไม่มีสัญญาณเตือน)
  //   ไม่ block — แค่เตือนให้ตรวจก่อนกด "อัปสเตทเมนต์"
  const duplicateNames = selectedNames.filter((n) => fileResults.some((r) => r.ok && r.fileName === n));

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
              setErr(`อัปโหลดได้ไม่เกิน ${MAX_FILES} ไฟล์ต่อรอบ (เลือกไว้ ${files.length} ไฟล์) — แบ่งอัปหลายรอบได้ ระบบจะรวมผลให้`);
            }
            setSelectedNames(files.map((f) => f.name));
          }}
        />
        <input
          type="text"
          value={pdfPassword}
          onChange={(e) => setPdfPassword(e.target.value)}
          placeholder="รหัสผ่าน PDF (ถ้าติดรหัส)"
          disabled={pending}
          autoComplete="off"
          style={{ maxWidth: 200 }}
        />
        <button type="button" className="btn" onClick={submit} disabled={pending}>
          {phase === "reading" ? "กำลังอัปโหลด + กำลังอ่าน…" : "อัปสเตทเมนต์ + แยกรายการ"}
        </button>
        {fileResults.length > 0 ? (
          <button type="button" className="btn btn-ghost" onClick={clearAll} disabled={pending}>
            ล้างรายการทั้งหมด
          </button>
        ) : null}
        {txns.length > 0 ? (
          <button type="button" className="btn btn-ghost" onClick={exportCsv}>
            ดาวน์โหลด CSV
          </button>
        ) : null}
        {txns.some((t) => t.direction === "in") ? (
          <button
            type="button"
            className="btn"
            disabled={creatingBills}
            title="สร้างบิลขาย (ร่าง) จากรายการเงินเข้า — ยืนยันแล้วไหลเข้าสมุดรายวัน/แยกประเภท/งบอัตโนมัติ"
            onClick={() => {
              setBillsMsg(null);
              setCreatingBills(true);
              createSaleBillsFromStatementAction({
                customerId,
                txns,
                sourceLabel: `สเตทเมนต์ (${selectedNames.join(", ").slice(0, 100) || customerLabel})`,
              })
                .then((r) => {
                  setBillsMsg({ ok: r.ok, text: r.message });
                  // บิลเพิ่งถูกสร้าง → กระทบกับบิลใหม่ให้คอลัมน์ "ตรงกับบิล" อัปเดตทันที
                  if (r.ok) void runBillMatch(txns);
                })
                .catch(() => setBillsMsg({ ok: false, text: "สร้างบิลไม่สำเร็จ กรุณาลองใหม่" }))
                .finally(() => setCreatingBills(false));
            }}
          >
            {creatingBills
              ? "กำลังสร้างบิล…"
              : `➕ สร้างบิลขาย (ร่าง) จากเงินเข้า ${txns.filter((t) => t.direction === "in").length.toLocaleString("th-TH")} รายการ`}
          </button>
        ) : null}
        {billsMsg ? (
          <span className={`action-msg ${billsMsg.ok ? "" : "err"}`} style={billsMsg.ok ? { color: "#166534" } : undefined}>
            {billsMsg.text}
          </span>
        ) : null}
      </div>
      {selectedNames.length > 0 ? (
        <div className="stmt-fname">
          เลือกไว้ {selectedNames.length} ไฟล์: {selectedNames.join(", ")}
        </div>
      ) : null}
      {duplicateNames.length > 0 ? (
        <div className="action-msg warn">
          ⚠ ชื่อไฟล์นี้เคยอ่านสำเร็จไปแล้ว: {duplicateNames.join(", ")} — ถ้าอัปซ้ำ ธุรกรรมจะถูกนับซ้ำสองรอบ
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
                  <span>
                    — อ่านสำเร็จ {r.transactions.length.toLocaleString("th-TH")} รายการ
                    {r.recon?.imported ? (
                      <b style={{ color: "#166534" }}>
                        {" "}· เซฟเข้าหน้ากระทบยอดธนาคารแล้ว {(r.recon.lineCount ?? 0).toLocaleString("th-TH")} รายการ
                      </b>
                    ) : r.recon && r.recon.reason === "duplicate" ? (
                      <span className="muted"> · ไฟล์นี้เคยเซฟเข้ากระทบยอดแล้ว (ไม่เซฟซ้ำ)</span>
                    ) : null}
                  </span>
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

          {/* ตารางธุรกรรม — แยกกอง "เงินเข้า" / "เงินออก" (requirement 2026-09-01) + คอลัมน์กระทบกับบิล */}
          <section className="stmt-section">
            <div className="stmt-upload-bar" style={{ marginBottom: 6 }}>
              <h3 className="stmt-h" style={{ margin: 0 }}>รายการธุรกรรม ({txns.length}) — แก้ได้</h3>
              <button type="button" className="btn btn-ghost" disabled={matching} onClick={() => void runBillMatch(txns)}>
                {matching ? "กำลังกระทบกับบิล…" : "🔄 กระทบกับบิลอีกครั้ง"}
              </button>
              {matches ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  ตรงกับบิลแล้ว {matches.filter(Boolean).length.toLocaleString("th-TH")}/{txns.length.toLocaleString("th-TH")} รายการ
                </span>
              ) : null}
            </div>
            <TxnPile
              title="💚 กองเงินเข้า"
              tone="in"
              txns={txns}
              matches={matches}
              bills={bills}
              reviewed={reviewed}
              manualPick={manualPick}
              creatingRow={creatingRow}
              filter={(t) => t.direction === "in"}
              updateTxn={updateTxn}
              onToggleReviewed={(i) =>
                setReviewed((prev) => {
                  const next = new Set(prev);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  return next;
                })
              }
              onManualPick={(i, b) => setManualPick((prev) => new Map(prev).set(i, b))}
              onCreateBill={(i, t) => createBillForRow(i, t, txns)}
            />
            <TxnPile
              title="🔻 กองเงินออก"
              tone="out"
              txns={txns}
              matches={matches}
              bills={bills}
              reviewed={reviewed}
              manualPick={manualPick}
              creatingRow={creatingRow}
              filter={(t) => t.direction === "out"}
              updateTxn={updateTxn}
              onToggleReviewed={(i) =>
                setReviewed((prev) => {
                  const next = new Set(prev);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  return next;
                })
              }
              onManualPick={(i, b) => setManualPick((prev) => new Map(prev).set(i, b))}
              onCreateBill={(i, t) => createBillForRow(i, t, txns)}
            />
            <TxnPile
              title="❔ ยังไม่ระบุทิศทาง"
              tone=""
              txns={txns}
              matches={matches}
              bills={bills}
              reviewed={reviewed}
              manualPick={manualPick}
              creatingRow={creatingRow}
              filter={(t) => t.direction !== "in" && t.direction !== "out"}
              updateTxn={updateTxn}
              onToggleReviewed={(i) =>
                setReviewed((prev) => {
                  const next = new Set(prev);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  return next;
                })
              }
              onManualPick={(i, b) => setManualPick((prev) => new Map(prev).set(i, b))}
              onCreateBill={(i, t) => createBillForRow(i, t, txns)}
              hideWhenEmpty
            />
            <p className="stmt-note">
              รายการถูกเซฟเข้า &ldquo;กระทบยอดธนาคาร&rdquo; ให้อัตโนมัติแล้ว (ดูสถานะรายไฟล์ด้านบน) —
              ฝั่งขวาเทียบกับบิลชุดเดียวกับหน้าลงบันทึกบัญชี ด้วยยอดเงิน + วันที่ + ชื่อผู้โอน
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}

/** วันที่ไทยสั้น: '2026-05-14' → '14 พ.ค. 69' (อ่านง่ายบนการ์ด) */
function thDate(d: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? "");
  if (!m) return d ?? "—";
  return `${Number(m[3])} ${TH_MONTHS[Number(m[2]) - 1] ?? m[2]} ${(Number(m[1]) + 543) % 100}`;
}

/** บรรทัด "โอนเมื่อ …" จากสเตทเมนต์ (โชว์ฝั่งบิลตาม requirement 2026-09-01) */
function TransferWhen({ t }: { t: StatementTxn }) {
  return (
    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
      🕐 โอนเมื่อ {thDate(t.date)}
      {t.time ? ` เวลา ${t.time} น.` : ""} (จากสเตทเมนต์)
    </div>
  );
}

/** การ์ดฝั่งขวา: ผลเทียบกับบิลในระบบของ 1 รายการ */
function BillSideCard({
  idx,
  t,
  match,
  matchesReady,
  bills,
  isReviewed,
  creating,
  onToggleReviewed,
  onManualPick,
  onCreateBill,
}: {
  idx: number;
  t: StatementTxn;
  match: BillMatch | BillForMatch | null;
  matchesReady: boolean;
  bills: BillForMatch[];
  isReviewed: boolean;
  creating: boolean;
  onToggleReviewed: (i: number) => void;
  onManualPick: (i: number, b: BillForMatch) => void;
  onCreateBill: (i: number, t: StatementTxn) => void;
}) {
  const [q, setQ] = useState("");
  const base = { borderRadius: 12, padding: "10px 12px", background: "#fff" } as const;

  if (!matchesReady) {
    return (
      <div style={{ ...base, border: "1px dashed #cbd5e1" }}>
        <span className="muted" style={{ fontSize: 13 }}>ยังไม่ได้กระทบกับบิล — กด &ldquo;🔄 กระทบกับบิลอีกครั้ง&rdquo; ด้านบน</span>
      </div>
    );
  }

  if (match) {
    const typeLabel = match.entryType === "sale" ? "บิลขาย" : match.entryType === "purchase" ? "บิลซื้อ" : "บิล";
    const nameHit = "nameHit" in match ? match.nameHit : true;
    const billId = "billId" in match ? match.billId : match.id;
    return (
      <div style={{ ...base, border: "2px solid #86efac" }}>
        <div style={{ color: "#166534", fontWeight: 600, fontSize: 13 }}>
          ✓ พบบิลตรง{nameHit ? " — ยอด + วัน + ชื่อตรง" : " (ยอด + วันตรง)"}
        </div>
        <div style={{ fontSize: 13, marginTop: 2 }}>
          {typeLabel}
          {match.docNo ? ` ${match.docNo}` : ""} · {match.status === "confirmed" ? "ยืนยันแล้ว" : "ร่าง"}
          {match.counterparty ? ` · คู่ค้า: ${match.counterparty}` : ""}
        </div>
        <TransferWhen t={t} />
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <a className="btn btn-ghost" href={`/chat-audit/accounting?edit=${billId}`} target="_blank" rel="noopener">
            เปิดบิล ↗
          </a>
          <button type="button" className={isReviewed ? "btn" : "btn btn-ghost"} onClick={() => onToggleReviewed(idx)}>
            {isReviewed ? "✓ ตรวจแล้ว" : "ติ๊กว่าตรวจแล้ว"}
          </button>
        </div>
      </div>
    );
  }

  // ไม่พบบิล — สร้างบิลขาย (เฉพาะเงินเข้า) หรือค้นบิลจับคู่มือ
  const qNorm = q.trim().toLowerCase();
  const hits = qNorm
    ? bills
        .filter(
          (b) =>
            (b.counterparty ?? "").toLowerCase().includes(qNorm) ||
            (b.docNo ?? "").toLowerCase().includes(qNorm) ||
            String(b.totalGross) === qNorm ||
            String(b.totalNet) === qNorm
        )
        .slice(0, 5)
    : [];
  return (
    <div style={{ ...base, border: "1px solid #fcd34d", background: "#fffbeb" }}>
      <div style={{ color: "#b45309", fontWeight: 600, fontSize: 13 }}>⚠ ไม่พบบิลที่ยอด/วัน/ชื่อตรง</div>
      <TransferWhen t={t} />
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
        {t.direction === "in" ? (
          <button type="button" className="btn" disabled={creating} onClick={() => onCreateBill(idx, t)}>
            {creating ? "กำลังสร้าง…" : "➕ สร้างบิลขายจากแถวนี้"}
          </button>
        ) : null}
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นบิลด้วยชื่อ/เลขที่/ยอด…"
          style={{ maxWidth: 180 }}
        />
        <button type="button" className={isReviewed ? "btn" : "btn btn-ghost"} onClick={() => onToggleReviewed(idx)}>
          {isReviewed ? "✓ ตรวจแล้ว" : "ไม่ต้องมีบิล (เช่น ค่าธรรมเนียม)"}
        </button>
      </div>
      {hits.length > 0 ? (
        <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, fontSize: 13 }}>
          {hits.map((b) => (
            <li key={b.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0" }}>
              <span>
                {b.entryType === "sale" ? "บิลขาย" : b.entryType === "purchase" ? "บิลซื้อ" : "บิล"}
                {b.docNo ? ` ${b.docNo}` : ""} · {thDate(b.docDate)} · {money(b.totalGross)}
                {b.counterparty ? ` · ${b.counterparty}` : ""}
              </span>
              <button type="button" className="btn btn-ghost" onClick={() => onManualPick(idx, b)}>
                เลือกจับคู่
              </button>
            </li>
          ))}
        </ul>
      ) : qNorm ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>ไม่พบบิลที่ตรงคำค้น</div>
      ) : null}
    </div>
  );
}

/** กองธุรกรรมหนึ่งทิศทาง — แถวละ 2 ฝั่ง: ซ้ายสเตทเมนต์ (แก้ได้) · ขวาบิลในระบบ (แบบ 2026-09-01) */
function TxnPile({
  title,
  tone,
  txns,
  matches,
  bills,
  reviewed,
  manualPick,
  creatingRow,
  filter,
  updateTxn,
  onToggleReviewed,
  onManualPick,
  onCreateBill,
  hideWhenEmpty = false,
}: {
  title: string;
  tone: "in" | "out" | "";
  txns: StatementTxn[];
  matches: (BillMatch | null)[] | null;
  bills: BillForMatch[];
  reviewed: Set<number>;
  manualPick: Map<number, BillForMatch>;
  creatingRow: number;
  filter: (t: StatementTxn) => boolean;
  updateTxn: (idx: number, patch: Partial<StatementTxn>) => void;
  onToggleReviewed: (i: number) => void;
  onManualPick: (i: number, b: BillForMatch) => void;
  onCreateBill: (i: number, t: StatementTxn) => void;
  hideWhenEmpty?: boolean;
}) {
  const rows = txns.map((t, i) => ({ t, i })).filter(({ t }) => filter(t));
  if (rows.length === 0 && hideWhenEmpty) return null;
  const total = rows.reduce((s, { t }) => s + (t.amount ?? 0), 0);
  const matchedCount = matches ? rows.filter(({ i }) => matches[i] || manualPick.has(i)).length : 0;
  return (
    <div style={{ marginBottom: 16 }}>
      <div className={`stmt-repeat-title ${tone}`}>
        {title} — {rows.length.toLocaleString("th-TH")} รายการ · รวม {money(total)}
        {matches ? ` · ตรงกับบิล ${matchedCount.toLocaleString("th-TH")}` : ""}
      </div>
      {rows.length === 0 ? (
        <p className="empty">ไม่มีรายการ</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map(({ t, i }) => {
            const amtColor = t.direction === "in" ? "#166534" : t.direction === "out" ? "#b91c1c" : "#475569";
            const manual = manualPick.get(i) ?? null;
            return (
              <div key={i} className="stmt-match-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {/* ซ้าย: รายการสเตทเมนต์ (แก้ได้) */}
                <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: "10px 12px", background: "#fff" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      value={t.date ?? ""}
                      placeholder="YYYY-MM-DD"
                      style={{ width: 110 }}
                      onChange={(e) => updateTxn(i, { date: e.target.value || null })}
                    />
                    {t.time ? <span className="muted" style={{ fontSize: 13 }}>{t.time} น.</span> : null}
                    <select
                      value={t.direction ?? ""}
                      onChange={(e) => updateTxn(i, { direction: (e.target.value || null) as TxnDirection | null })}
                    >
                      <option value="">—</option>
                      <option value="in">เข้า</option>
                      <option value="out">ออก</option>
                    </select>
                    <span style={{ flex: 1 }} />
                    <input
                      type="number"
                      step="0.01"
                      value={t.amount ?? ""}
                      style={{ width: 120, textAlign: "right", color: amtColor, fontWeight: 600 }}
                      onChange={(e) => {
                        const n = e.target.value === "" ? null : Number(e.target.value);
                        updateTxn(i, { amount: n != null && Number.isFinite(n) ? n : null });
                      }}
                    />
                  </div>
                  <input
                    type="text"
                    value={t.counterparty_name ?? ""}
                    placeholder="ชื่อผู้โอน"
                    style={{ width: "100%", marginTop: 6, fontWeight: 600 }}
                    onChange={(e) => updateTxn(i, { counterparty_name: e.target.value || null })}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <input
                      type="text"
                      value={t.description ?? ""}
                      placeholder="รายละเอียด"
                      style={{ flex: 1, fontSize: 13 }}
                      onChange={(e) => updateTxn(i, { description: e.target.value || null })}
                    />
                    <input
                      type="text"
                      value={t.counterparty_account_no ?? ""}
                      placeholder="เลขบัญชี"
                      style={{ width: 130, fontSize: 13 }}
                      onChange={(e) => updateTxn(i, { counterparty_account_no: e.target.value || null })}
                    />
                  </div>
                </div>
                {/* ขวา: บิลในระบบ */}
                <BillSideCard
                  idx={i}
                  t={t}
                  match={matches ? (manual ?? matches[i]) : null}
                  matchesReady={!!matches}
                  bills={bills}
                  isReviewed={reviewed.has(i)}
                  creating={creatingRow === i}
                  onToggleReviewed={onToggleReviewed}
                  onManualPick={onManualPick}
                  onCreateBill={onCreateBill}
                />
              </div>
            );
          })}
        </div>
      )}
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
