"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import {
  createStatementUploadUrlAction,
  matchStatementWithBillsAction,
  learnStatementAccountAction,
  type AccountSuggestion,
  listSavedStatementsAction,
  loadSavedStatementAction,
  loadStatementReviewStateAction,
  saveStatementReviewStateAction,
  type SavedStatementFile,
} from "./statement-actions";
import type { BillMatch, BillForMatch } from "@/lib/accounting/statement-bill-match";
import { createClient as createBrowserSupabase } from "@/lib/supabase/client";
import { createBillUploadUrlAction, finalizeBillUploadAction } from "./actions";
import { UPLOAD_ACCEPT, MAX_UPLOAD_BYTES, validateUpload } from "@/lib/accounting/upload";
import {
  summarizeByMonth,
  findRepeatCounterparties,
  bkkMonthKey,
  type StatementTxn,
  type TxnDirection,
} from "@/lib/accounting/statement-analyze";
import { toCsv } from "@/lib/accounting/csv-export";
import NovaMascot from "../../liff/survey/[token]/NovaMascot";
import AccountCombobox from "./AccountCombobox";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";

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
  /** path ใน storage (ใช้เป็นคีย์กันรวมซ้ำ — ชื่อไฟล์ไทยถูก sanitize จนชนกันได้ เช่น "69.pdf") */
  path?: string;
  ok: boolean;
  errorMessage?: string;
  transactions: StatementTxn[];
  meta: StatementMeta;
  recon?: ReconInfo;
  /** จำนวนรายการที่ถูกตัดเพราะซ้ำกับไฟล์อื่นที่โหลดแล้ว (ไฟล์ช่วงเวลาทับซ้อน — กันยอดเบิ้ล) */
  droppedDup?: number;
};

/** คีย์ประจำรายการ (ผูกกับเนื้อหา ไม่ใช่ลำดับแถว) — ใช้จำติ๊ก "ตรวจแล้ว"/จับคู่มือ ข้ามการเปิดหน้า */
function txnKey(t: StatementTxn): string {
  const ref = (t.counterparty_account_no || t.counterparty_name || t.description || "").slice(0, 40);
  return `${t.date ?? ""}|${(t.amount ?? 0).toFixed(2)}|${t.direction ?? ""}|${t.time ?? ""}|${ref}`;
}

/** ลายเซ็นเนื้อหาสเตทเมนต์ — กันไฟล์เดิมที่ถูกอัปซ้ำหลายรอบ (path ต่างแต่เนื้อเหมือน) โหลดซ้อนกัน */
function contentSig(txns: StatementTxn[]): string {
  const total = txns.reduce((s, t) => s + (t.amount ?? 0), 0);
  return `${txns.length}|${txns[0]?.date ?? ""}|${txns[txns.length - 1]?.date ?? ""}|${total.toFixed(2)}`;
}

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
  chart,
}: {
  customerId: string;
  customerLabel: string;
  /** ผังบัญชีของ tenant (จาก page.tsx) — ช่องบัญชีคู่บนแถวกระทบยอด (2026-09-02) */
  chart: ChartAccount[];
}) {
  const [pending, startTransition] = useTransition();
  // accountant param จาก URL (overlay แนบมา) — ติดไปกับลิงก์ "เปิดบิล" ให้ปุ่มปิดพากลับบริบทเดิม
  const searchParams = useSearchParams();
  const accountant = searchParams.get("accountant");
  const [phase, setPhase] = useState<"" | "reading">("");
  const [err, setErr] = useState<string | null>(null);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [txns, setTxns] = useState<StatementTxn[]>([]);
  // ข้อความสถานะ (อัปบิล/กระทบ ฯลฯ)
  const [billsMsg, setBillsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [pdfPassword, setPdfPassword] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // กระทบกับบิลในระบบ (index ตรงกับ txns) — null ในช่อง = รายการนั้นไม่พบบิล · null ทั้งก้อน = ยังไม่ได้กระทบ
  const [matches, setMatches] = useState<(BillMatch | null)[] | null>(null);
  const [matching, setMatching] = useState(false);
  // บิลทั้งหมดของลูกค้า (จาก action เดียวกัน) — ใช้ช่อง "ค้นบิล" กรองฝั่ง client
  const [bills, setBills] = useState<BillForMatch[]>([]);
  // ★ "จำติ๊ก" (2026-09-01): ติ๊ก "ตรวจแล้ว" + จับคู่มือ คีย์ด้วยเนื้อหารายการ (txnKey) —
  //   โหลดจาก review-state.json ตอนเปิดหน้า และเซฟกลับอัตโนมัติ (debounce) ทุกครั้งที่เปลี่ยน
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  // จับคู่มือ: คีย์รายการ → billId (ตัวบิลดูจาก bills ที่กระทบล่าสุด)
  const [manualPick, setManualPick] = useState<Map<string, string>>(new Map());
  // ★ บัญชีคู่ที่นักบัญชีเลือกบนแถวกระทบยอด (คีย์รายการ → "code|name") — จำถาวรใน review-state
  const [accountPick, setAccountPick] = useState<Map<string, string>>(new Map());
  // คำแนะนำบัญชีจาก learning map (index ตรง txns) — เฉพาะรายการไม่พบบิล
  const [accountSuggestions, setAccountSuggestions] = useState<AccountSuggestion[] | null>(null);
  // โหลดสถานะติ๊กเสร็จแล้ว (กันเซฟทับด้วยค่าว่างก่อนโหลด)
  const reviewLoadedRef = useRef(false);
  // ★ "ระบบจำไว้" (2026-09-01): ไฟล์ที่เคยอัปของลูกค้า — ผลอ่านที่เซฟไว้โหลดขึ้นเองตอนเปิดหน้า
  const [savedFiles, setSavedFiles] = useState<SavedStatementFile[] | null>(null);
  // กำลังโหลดผลที่จำไว้ตอนเปิดหน้า (โชว์น้อง NOVA วิ่ง)
  const [autoLoading, setAutoLoading] = useState(true);
  // ★ กรองรายเดือน (2026-09-02): คลิกการ์ดเดือน → รายการจับคู่ด้านล่างเหลือเฉพาะเดือนนั้น
  //   (เลื่อนดูง่าย) · คลิกซ้ำ/กดล้าง = กลับมาทุกเดือน · null = ไม่กรอง
  const [monthFilter, setMonthFilter] = useState<string | null>(null);
  const txnSectionRef = useRef<HTMLElement | null>(null);
  const monthSectionRef = useRef<HTMLElement | null>(null);
  const inMonth = useCallback(
    (t: StatementTxn) => !monthFilter || (bkkMonthKey(t.date) ?? "") === monthFilter,
    [monthFilter]
  );
  // path ที่กำลังอ่านซ้ำจาก storage (ไฟล์เก่าที่ยังไม่มีผลเซฟ)
  const [rereading, setRereading] = useState<string | null>(null);
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
          setBills(r.bills); // จับคู่มือคีย์ด้วยเนื้อหารายการ — คงไว้ได้ (ไม่อิงลำดับแล้ว)
          setAccountSuggestions(r.accountSuggestions ?? null);
        }
      } catch {
        setMatches(null);
      } finally {
        setMatching(false);
      }
    },
    [customerId]
  );

  // flag "อ่าน/สร้างบิลเสร็จแล้ว รอกระทบกับบิล" — effect ยิงหลัง txns commit จริง (กัน stale closure)
  const wantMatchRef = useRef(false);
  useEffect(() => {
    if (!wantMatchRef.current) return;
    wantMatchRef.current = false;
    void runBillMatch(txns);
  }, [txns, runBillMatch]);

  // คีย์ที่รวมผลแล้ว (ref — dedup ตอนโหลดอัตโนมัติ/อ่านซ้ำ โดยไม่พึ่ง state ใน closure):
  //   path (ชื่อไฟล์ไทยถูก sanitize จนชนกันได้) + ลายเซ็นเนื้อหา (ไฟล์เดิมอัปซ้ำหลายรอบ path ต่างกัน)
  const mergedKeysRef = useRef<Set<string>>(new Set());
  // ★ กันยอดเบิ้ล (พบจริง 2026-09-02): ลูกค้าดึงสเตทเมนต์ "ช่วงยาว" (มีค-กค) + "รายเดือน" ของบัญชี
  //   เดียวกันมาพร้อมกัน → รายการเดียวกันโผล่ 2 ไฟล์ → นับซ้ำ. dedup ระดับรายการแบบ multiset:
  //   จำนวนต่อคีย์ (วัน|ยอด|ทิศ|เวลา|อ้างอิง) = max ข้ามไฟล์ — รายการที่ซ้ำกันจริงในไฟล์เดียว
  //   (เช่นโอน 2 ครั้งยอดเท่ากันคนเดียวกัน) ยังนับครบ ไม่โดนตัดทิ้ง
  const mergedTxnCountsRef = useRef<Map<string, number>>(new Map());

  /** รวมผลไฟล์เข้า state เดียวจุด — allowDup=true เฉพาะการอัปเองซ้ำโดยตั้งใจ (มีคำเตือนอยู่แล้ว)
   *  ตัดรายการซ้ำข้ามไฟล์เสมอ (ทุกทางเข้า รวมอัปเอง) · คืนจำนวนไฟล์ที่รวมจริง */
  const addResults = useCallback((incoming: FileResult[], allowDup: boolean): number => {
    const okOnes = incoming.filter((r) => r.ok);
    const fresh: FileResult[] = [];
    let droppedTotal = 0;
    for (const r of okOnes) {
      const keys = [r.path ?? `name:${r.fileName}`, `sig:${contentSig(r.transactions)}`];
      if (!allowDup && keys.some((k) => mergedKeysRef.current.has(k))) continue;
      keys.forEach((k) => mergedKeysRef.current.add(k));

      // ตัดรายการที่มีครบแล้วจากไฟล์ก่อนหน้า (multiset — ดูคอมเมนต์ mergedTxnCountsRef)
      const fileCounts = new Map<string, number>();
      const kept: StatementTxn[] = [];
      let dropped = 0;
      for (const t of r.transactions) {
        const k = txnKey(t);
        const seenInFile = (fileCounts.get(k) ?? 0) + 1;
        fileCounts.set(k, seenInFile);
        if (seenInFile > (mergedTxnCountsRef.current.get(k) ?? 0)) kept.push(t);
        else dropped += 1;
      }
      for (const [k, c] of fileCounts) {
        if (c > (mergedTxnCountsRef.current.get(k) ?? 0)) mergedTxnCountsRef.current.set(k, c);
      }
      droppedTotal += dropped;
      fresh.push({ ...r, transactions: kept, droppedDup: dropped });
    }
    const failed = incoming.filter((r) => !r.ok);
    if (fresh.length === 0 && failed.length === 0) return 0;
    setFileResults((prev) => [...prev, ...fresh, ...failed]);
    const addedTxns = fresh.flatMap((r) => r.transactions);
    if (addedTxns.length > 0) {
      wantMatchRef.current = true;
      setTxns((prev) => [...prev, ...addedTxns]);
    }
    if (droppedTotal > 0) {
      setBillsMsg({
        ok: true,
        text: `กันยอดเบิ้ลให้แล้ว: ตัดรายการซ้ำ ${droppedTotal.toLocaleString("th-TH")} รายการ (ไฟล์ช่วงเวลาทับซ้อนกัน เช่น สเตทเมนต์รายเดือน + ช่วงยาวของบัญชีเดียวกัน)`,
      });
    }
    return fresh.length;
  }, []);

  // ★ เปิดหน้า → โหลด "ผลอ่านที่ระบบจำไว้" ของลูกค้ารายนี้ขึ้นมาเอง (ไม่ต้องอัป/อ่านซ้ำ)
  const autoLoadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (autoLoadedForRef.current === customerId) return; // กัน StrictMode/re-render ยิงซ้ำ
    autoLoadedForRef.current = customerId;
    let cancelled = false;
    // โหลดติ๊กที่จำไว้ (ขนานกับผลอ่าน — ไม่บล็อกกัน)
    void loadStatementReviewStateAction({ customerId })
      .then((r) => {
        if (cancelled || !r.ok) return;
        setReviewed(new Set(r.state.reviewed));
        setManualPick(new Map(Object.entries(r.state.manual)));
        setAccountPick(new Map(Object.entries(r.state.accounts ?? {})));
        reviewLoadedRef.current = true;
      })
      .catch(() => {
        reviewLoadedRef.current = true; // โหลดพัง = เริ่มว่าง แต่ยังให้เซฟติ๊กใหม่ได้
      });
    (async () => {
      const r = await listSavedStatementsAction({ customerId }).catch(() => null);
      if (cancelled) return;
      if (!r || !r.ok) {
        setSavedFiles([]);
        setAutoLoading(false);
        return;
      }
      setSavedFiles(r.files);
      const withSaved = r.files.filter((f) => f.hasSaved).slice(0, 12);
      // ★ perf 2026-09-01: โหลดขนาน (เดิมทีละไฟล์ 12 รอบ ~4 วิ → พร้อมกัน 4 ~1 วิ)
      const results = await mapWithConcurrency(withSaved, 4, (f) =>
        loadSavedStatementAction({ customerId, path: f.path })
          .then((s) => ({ f, s }))
          .catch(() => ({ f, s: null as null }))
      );
      if (cancelled) return;
      const loaded: FileResult[] = [];
      for (const { f, s } of results) {
        if (s && s.ok && s.transactions.length > 0) {
          loaded.push({ fileName: s.fileName, path: f.path, ok: true, transactions: s.transactions, meta: null, recon: null });
        }
      }
      if (!cancelled && loaded.length > 0) {
        addResults(loaded, false);
        setDone(true);
      }
      if (!cancelled) setAutoLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId, addResults]);

  // ★ เซฟติ๊กทันทีทุกครั้งที่เปลี่ยน (ไม่ debounce — ติ๊กแล้วรีบปิดหน้าต่างก็ไม่หาย) —
  //   หลังโหลดค่าเดิมแล้วเท่านั้น (กันเซฟทับด้วยค่าว่าง) · เขียนไฟล์เล็ก + คนคลิกไม่ถี่ = ไม่หนัก
  useEffect(() => {
    if (!reviewLoadedRef.current) return;
    void saveStatementReviewStateAction({
      customerId,
      state: {
        reviewed: Array.from(reviewed),
        manual: Object.fromEntries(manualPick),
        accounts: Object.fromEntries(accountPick),
      },
    });
  }, [reviewed, manualPick, accountPick, customerId]);

  // ★ บิลที่อัปจากหน้าอื่น (เช่นกล่องอัปโหลดบิล/แท็บเปิดบิล) โผล่มาจับคู่เองเมื่อกลับมาหน้านี้ —
  //   กระทบใหม่ตอนหน้าถูกโฟกัส/สลับแท็บกลับมา (throttle 15 วิ · ข้ามตอนเพิ่งเปิดหน้า)
  const lastWakeMatchRef = useRef<number>(Date.now());
  useEffect(() => {
    const onWake = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastWakeMatchRef.current < 15000) return;
      lastWakeMatchRef.current = now;
      // trigger ผ่าน flag+effect — ใช้ txns ล่าสุดจริงเสมอ (ไม่มีรายการ = ไม่ทำอะไร)
      setTxns((prev) => {
        if (prev.length === 0) return prev;
        wantMatchRef.current = true;
        return [...prev];
      });
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, []);

  // แถวที่กำลังอัปรูปบิลเพิ่ม (-1 = ไม่มี) — ปุ่มบนการ์ด "ไม่พบบิล"
  const [uploadingRow, setUploadingRow] = useState<number>(-1);

  /** อัปรูปบิลจากแถวที่หาบิลไม่เจอ → สร้างบิล (ประเภทตามทิศทางเงิน) → AI อ่าน → กระทบใหม่ทันที */
  async function uploadBillForRow(idx: number, t: StatementTxn, file: File) {
    const v = validateUpload({ mime: file.type, name: file.name, size: file.size });
    if (!v.ok) {
      setBillsMsg({ ok: false, text: `${file.name}: ${v.error}` });
      return;
    }
    setUploadingRow(idx);
    setBillsMsg(null);
    try {
      const entryType = t.direction === "in" ? "sale" : t.direction === "out" ? "purchase" : "unspecified";
      const prep = await createBillUploadUrlAction({
        customerId,
        entryType,
        fileName: file.name,
        mime: file.type,
        size: file.size,
      });
      if (!prep.ok) {
        setBillsMsg({ ok: false, text: prep.message });
        return;
      }
      const supabase = createBrowserSupabase();
      const { error: upErr } = await supabase.storage
        .from(BILLS_BUCKET)
        .uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type || undefined });
      if (upErr) {
        setBillsMsg({ ok: false, text: "อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่" });
        return;
      }
      const fin = await finalizeBillUploadAction({
        customerId,
        entryType,
        path: prep.path,
        name: file.name,
        mime: file.type,
      });
      if (!fin.ok) {
        setBillsMsg({ ok: false, text: fin.message });
        return;
      }
      // รอ AI อ่านบิลให้จบ (แถวเดียว ไม่นาน) แล้วกระทบใหม่ — บิลใหม่จะขึ้นฝั่งขวาเองถ้ายอด/วันตรง
      if (fin.id) {
        try {
          await fetch("/api/accounting/extract-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entryId: fin.id }),
          });
        } catch {
          // อ่านไม่จบก็ไม่เป็นไร — บิลอยู่ในระบบแล้ว ไปคีย์ต่อที่หน้าตรวจได้
        }
      }
      // กระทบใหม่ผ่าน flag+effect (ใช้ txns ล่าสุดจริง — กัน stale closure)
      wantMatchRef.current = true;
      setTxns((prev) => [...prev]);
      setBillsMsg({
        ok: true,
        text: "อัปบิลเข้าแล้ว — ถ้าฝั่งขวายังไม่ขึ้นเขียว แปลว่า AI อ่านยอด/วันที่ได้ไม่ตรง ให้กดเปิดบิลไปตรวจ",
      });
    } finally {
      setUploadingRow(-1);
    }
  }

  /** เลือกบัญชีคู่บนแถวกระทบยอด: จำถาวร (review-state) + สอน learning map ให้แนะนำเองรอบหน้า */
  const pickAccount = useCallback(
    (k: string, t: StatementTxn, code: string, name: string) => {
      setAccountPick((prev) => new Map(prev).set(k, `${code}|${name}`));
      if (t.counterparty_name && (t.direction === "in" || t.direction === "out")) {
        void learnStatementAccountAction({
          customerId,
          direction: t.direction,
          counterpartyName: t.counterparty_name,
          accountCode: code,
          accountName: name,
        });
      }
    },
    [customerId]
  );
  const clearAccount = useCallback((k: string) => {
    setAccountPick((prev) => {
      const next = new Map(prev);
      next.delete(k);
      return next;
    });
  }, []);

  /** อ่านไฟล์ที่อยู่ใน storage อยู่แล้วอีกครั้ง (ไฟล์เก่าที่ยังไม่มีผลเซฟ) — ไม่ต้องอัปโหลดใหม่ */
  function rereadStored(f: SavedStatementFile) {
    setRereading(f.path);
    fetch("/api/accounting/extract-statement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: f.path, customerId, fileName: f.name, password: pdfPassword || undefined }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; transactions?: StatementTxn[]; meta?: StatementMeta; recon?: ReconInfo; message?: string }
          | null;
        if (!res.ok || !data?.ok || !Array.isArray(data.transactions)) {
          addResults([{ fileName: f.name, ok: false, errorMessage: data?.message ?? "อ่านไม่สำเร็จ กรุณาลองใหม่", transactions: [], meta: null }], false);
          return;
        }
        const merged = addResults(
          [{ fileName: f.name, path: f.path, ok: true, transactions: data.transactions, meta: data.meta ?? null, recon: data.recon ?? null }],
          false
        );
        if (merged === 0) {
          setBillsMsg({ ok: true, text: `"${f.name}" เนื้อหาซ้ำกับไฟล์ที่โหลดไว้แล้ว — ไม่รวมซ้ำ (แต่เซฟผลไว้ให้แล้ว รอบหน้าโหลดเอง)` });
        }
        setDone(true);
        // ตอนนี้มีผลเซฟแล้ว (route เซฟ sidecar ให้) — อัปสถานะในลิสต์
        setSavedFiles((prev) => prev?.map((x) => (x.path === f.path ? { ...x, hasSaved: true } : x)) ?? prev);
      })
      .catch(() => {
        addResults([{ fileName: f.name, ok: false, errorMessage: "อ่านไม่สำเร็จ กรุณาลองใหม่", transactions: [], meta: null }], false);
      })
      .finally(() => setRereading(null));
  }

  // สรุปรายเดือน + คนโอนซ้ำ คำนวณใหม่ทุกครั้งที่ตารางเปลี่ยน (helper เดียวกับ server) — รวมทุกไฟล์แล้ว
  const monthly = useMemo(() => summarizeByMonth(txns), [txns]);
  // ★ คนโอนซ้ำ "แยกรายเดือน" + สรุปท้าย (แบบที่ผู้ใช้อนุมัติ 2026-09-02):
  //   ซ้ำ = ≥2 ครั้งภายในเดือนเดียวกัน · ท้ายการ์ดเดือน = สรุปทุกรายการของเดือน ·
  //   ท้ายสุด = รวมทุกเดือน (เข้ากี่ครั้ง/ออกกี่ครั้ง/ยอด/สุทธิ)
  const monthlyRepeats = useMemo(() => {
    const byMonth = new Map<string, StatementTxn[]>();
    for (const t of txns) {
      const k = bkkMonthKey(t.date) ?? "";
      const arr = byMonth.get(k) ?? [];
      arr.push(t);
      byMonth.set(k, arr);
    }
    return [...monthly]
      .sort((a, b) => (b.month || "").localeCompare(a.month || "")) // ใหม่ → เก่า
      .map((m) => {
        // minCount 1 = ทุกคน (โอนซ้ำเรียงอยู่บนสุด — requirement 2026-09-02)
        const rep = findRepeatCounterparties(byMonth.get(m.month || "") ?? [], { minCount: 1 });
        return {
          ...m,
          repeatIn: rep.filter((r) => r.direction === "in"),
          repeatOut: rep.filter((r) => r.direction === "out"),
        };
      });
  }, [txns, monthly]);
  const grandTotal = useMemo(() => {
    let inCount = 0, inTotal = 0, outCount = 0, outTotal = 0;
    for (const m of monthly) {
      inCount += m.inCount;
      inTotal += m.inTotal;
      outCount += m.outCount;
      outTotal += m.outTotal;
    }
    return { inCount, inTotal, outCount, outTotal, net: inTotal - outTotal };
  }, [monthly]);

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
      // อัปเอง = ตั้งใจ (มีคำเตือนไฟล์ซ้ำก่อนกดแล้ว) → allowDup (ไฟล์ที่อ่านสำเร็จจะกระทบกับบิลผ่าน effect)
      addResults(results, true);
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
    // ★ ไม่ล้าง reviewed/manualPick — "จำติ๊ก" ผูกกับเนื้อหารายการ โหลดกลับมาก็ติ๊กอยู่
    mergedKeysRef.current = new Set();
    mergedTxnCountsRef.current = new Map();
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

      {/* ★ น้อง NOVA วิ่ง (requirement 2026-09-01) — ให้นักบัญชีเห็นว่ากำลังโหลด/อ่านอยู่ */}
      {phase === "reading" || autoLoading || rereading ? (
        <div className="stmt-nova">
          <NovaMascot variant="loader" width={150} />
          <div className="stmt-nova-text">
            {phase === "reading"
              ? `น้อง NOVA กำลังอัปโหลด + อ่านสเตทเมนต์${selectedNames.length > 1 ? ` ทั้ง ${selectedNames.length} ไฟล์` : ""}…`
              : rereading
                ? "น้อง NOVA กำลังอ่านไฟล์เดิมอีกครั้ง…"
                : "น้อง NOVA กำลังโหลดผลสเตทเมนต์ที่จำไว้…"}
          </div>
          <div className="stmt-nova-sub">ไฟล์ยาว/หลายไฟล์อาจใช้เวลาสักครู่ — ไม่ต้องกดซ้ำ</div>
        </div>
      ) : null}

      {/* ★ feedback 2026-09-01 (รอบ 2): เอาแถบไฟล์ด้านซ้ายออก — เหลือ
          1) แถวเตือนเฉพาะไฟล์ที่ยังไม่มีผลจำ (ปกติไม่โผล่ — ทุกการอ่านเซฟอัตโนมัติแล้ว)
          2) บรรทัดสรุป "อ่านแล้ว N ไฟล์" กดกางดูรายไฟล์ได้ · ผลอ่านกินเต็มหน้า */}
      {savedFiles?.some((f) => !f.hasSaved) ? (
        <div className="action-msg warn" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span>ไฟล์ที่ยังไม่มีผลจำ (อัปไว้ก่อนระบบจำจะเปิดใช้):</span>
          {savedFiles
            .filter((f) => !f.hasSaved)
            .map((f) => (
              <button
                key={f.path}
                type="button"
                className="btn btn-ghost"
                disabled={rereading !== null}
                onClick={() => rereadStored(f)}
              >
                {rereading === f.path ? "กำลังอ่าน…" : `อ่าน "${f.name}" อีกครั้ง`}
              </button>
            ))}
        </div>
      ) : null}

      {done && fileResults.length > 0 ? (
        <details className="stmt-read-summary">
          <summary>
            📄 อ่านแล้ว {successCount.toLocaleString("th-TH")} ไฟล์ · รวม {txns.length.toLocaleString("th-TH")} รายการ
            {fileResults.length > successCount ? ` · ล้มเหลว ${(fileResults.length - successCount).toLocaleString("th-TH")}` : ""}
            {" — กดดูรายไฟล์"}
          </summary>
          <ul className="stmt-file-status-list">
            {fileResults.map((r, i) => (
              <li key={i} className={r.ok ? "ok" : "err"}>
                <b>{r.fileName}</b>{" "}
                {!r.ok ? (
                  <span>— ล้มเหลว: {r.errorMessage ?? "ไม่ทราบสาเหตุ"}</span>
                ) : r.meta?.truncated ? (
                  <span>
                    — อ่าน {r.transactions.length.toLocaleString("th-TH")} รายการ (ไฟล์ใหญ่ — อ่านไป{" "}
                    {r.meta.includedRows.toLocaleString("th-TH")}/{r.meta.totalRows.toLocaleString("th-TH")} แถว)
                  </span>
                ) : r.meta && r.meta.failedChunks > 0 ? (
                  <span>— อ่านได้บางส่วน ({r.meta.chunkCount - r.meta.failedChunks}/{r.meta.chunkCount} ชุด)</span>
                ) : r.transactions.length === 0 ? (
                  <span>— ไม่พบรายการ</span>
                ) : (
                  <span>
                    — {r.transactions.length.toLocaleString("th-TH")} รายการ
                    {r.droppedDup ? (
                      <span style={{ color: "#b45309" }}> · ตัดซ้ำ {r.droppedDup.toLocaleString("th-TH")} (มีในไฟล์อื่นแล้ว)</span>
                    ) : null}
                    {r.recon?.imported ? (
                      <b style={{ color: "#166534" }}> · เข้ากระทบยอดแล้ว</b>
                    ) : r.recon && r.recon.reason === "duplicate" ? (
                      <span className="muted"> · เคยเข้ากระทบยอดแล้ว</span>
                    ) : null}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {done && txns.length === 0 && !hasAnyIssue ? (
        <div className="card"><p className="empty">อ่านไม่พบรายการธุรกรรม ลองไฟล์อื่น หรือตรวจว่าเป็นสเตทเมนต์จริง</p></div>
      ) : null}
      {!done && !autoLoading && txns.length === 0 ? (
        <div className="card">
          <p className="empty">เลือกไฟล์สเตทเมนต์ด้านบนแล้วกด &ldquo;อัปสเตทเมนต์ + แยกรายการ&rdquo; — ผลที่เคยอ่านจะโหลดขึ้นเองถ้ามี</p>
        </div>
      ) : null}

      {txns.length > 0 ? (
        <>
          {/* การ์ดสรุปรายเดือน (รวมทุกไฟล์) */}
          <section className="stmt-section" ref={monthSectionRef}>
            <h3 className="stmt-h">สรุปรายเดือน{fileResults.length > 1 ? " (รวมทุกไฟล์)" : ""}</h3>
            <div className="stmt-month-cards">
              {monthly.map((m) => (
                <div
                  key={m.month || "none"}
                  className="stmt-month-card"
                  role="button"
                  tabIndex={0}
                  aria-pressed={monthFilter === (m.month || "")}
                  title="คลิกเพื่อดูรายการเฉพาะเดือนนี้ (คลิกซ้ำเพื่อดูทุกเดือน)"
                  style={{
                    cursor: "pointer",
                    ...(monthFilter === (m.month || "")
                      ? { border: "2px solid #2563eb", boxShadow: "0 0 0 3px #dbeafe" }
                      : undefined),
                  }}
                  onClick={() => {
                    const key = m.month || "";
                    const next = monthFilter === key ? null : key;
                    setMonthFilter(next);
                    if (next) txnSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      const key = m.month || "";
                      setMonthFilter((prev) => (prev === key ? null : key));
                    }
                  }}
                >
                  <div className="stmt-month-title">{monthLabel(m.month)}</div>
                  <div className="stmt-month-row in">
                    <span>เงินเข้า ({m.inCount})</span>
                    <b>{money(m.inTotal)}</b>
                  </div>
                  <div className="stmt-month-row out">
                    <span>เงินออก ({m.outCount})</span>
                    <b>{money(m.outTotal)}</b>
                  </div>
                  {m.closeBalance != null && m.openBalance != null ? (
                    <>
                      {/* ★ 2026-09-02 ยอดยกมา/ยกไป = ยอดคงเหลือ ณ ต้น/สิ้นงวด จากคอลัมน์ balance
                          ของสเตทเมนต์จริง (ไม่ใช่แค่ เข้า−ออก) — ไฟล์ที่อ่านด้วย AI ไม่มี balance
                          จะ fallback โชว์สุทธิแบบเดิม */}
                      <div className="stmt-month-net">
                        <span>ยอดยกมา (ต้นงวด)</span>
                        <b>{money(m.openBalance)}</b>
                      </div>
                      <div className="stmt-month-net">
                        <span>ยอดยกไป (สิ้นงวด)</span>
                        <b>{money(m.closeBalance)}</b>
                      </div>
                    </>
                  ) : (
                    <div className="stmt-month-net">
                      <span>คงเหลือสุทธิ</span>
                      <b>{money(m.inTotal - m.outTotal)}</b>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* ★ คนโอนซ้ำ แยกรายเดือน + สรุปท้ายเดือน/รวมทุกเดือน (แบบผู้ใช้อนุมัติ 2026-09-02) */}
          <section className="stmt-section">
            <h3 className="stmt-h">ผู้โอนเข้า/ออก ทุกคน (คนโอนซ้ำอยู่บนสุด) — แยกรายเดือน</h3>
            {monthlyRepeats.map((m) => (
              <div
                key={m.month || "none"}
                style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "10px 14px", marginBottom: 10 }}
              >
                <div style={{ fontWeight: 700, marginBottom: 6 }}>📅 {monthLabel(m.month)}</div>
                <div className="stmt-repeat-grid">
                  <RepeatTable title="โอนเข้า (ซ้ำ ≥2 ครั้ง อยู่บนสุด)" rows={m.repeatIn} tone="in" />
                  <RepeatTable title="โอนออก (ซ้ำ ≥2 ครั้ง อยู่บนสุด)" rows={m.repeatOut} tone="out" />
                </div>
                <div
                  style={{
                    borderTop: "1px solid #e2e8f0",
                    marginTop: 8,
                    paddingTop: 6,
                    fontSize: 13,
                    display: "flex",
                    gap: 16,
                    flexWrap: "wrap",
                  }}
                >
                  <span className="muted">สรุปเดือนนี้ (ทุกรายการ):</span>
                  <b style={{ color: "#166534" }}>เข้า {m.inCount.toLocaleString("th-TH")} ครั้ง · {money(m.inTotal)}</b>
                  <b style={{ color: "#b91c1c" }}>ออก {m.outCount.toLocaleString("th-TH")} ครั้ง · {money(m.outTotal)}</b>
                  <span>สุทธิ {money(m.inTotal - m.outTotal)}</span>
                </div>
              </div>
            ))}
            {/* สรุปรวมทุกเดือน (ตรงท้าย) */}
            <div style={{ background: "#eff6ff", borderRadius: 12, padding: "10px 14px" }}>
              <div style={{ fontWeight: 700, color: "#1d4ed8", marginBottom: 4 }}>Σ สรุปรวมทุกเดือน</div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 14 }}>
                <span style={{ color: "#166534" }}>
                  เงินเข้า <b>{grandTotal.inCount.toLocaleString("th-TH")} ครั้ง · {money(grandTotal.inTotal)}</b>
                </span>
                <span style={{ color: "#b91c1c" }}>
                  เงินออก <b>{grandTotal.outCount.toLocaleString("th-TH")} ครั้ง · {money(grandTotal.outTotal)}</b>
                </span>
                <span style={{ color: "#1d4ed8" }}>
                  คงเหลือสุทธิ <b>{money(grandTotal.net)}</b>
                </span>
                {(() => {
                  // monthly เรียงใหม่→เก่า: ยกมา = เดือนเก่าสุดที่มี balance · ยกไป = เดือนใหม่สุด
                  const withBal = monthly.filter((m) => m.openBalance != null && m.closeBalance != null);
                  if (withBal.length === 0) return null;
                  const oldest = withBal[withBal.length - 1];
                  const newest = withBal[0];
                  return (
                    <>
                      <span className="muted">ยกมาต้นงวด {money(oldest.openBalance as number)}</span>
                      <span className="muted">ยกไปสิ้นงวด {money(newest.closeBalance as number)}</span>
                    </>
                  );
                })()}
              </div>
            </div>
          </section>

          {/* ตารางธุรกรรม — แยกกอง "เงินเข้า" / "เงินออก" (requirement 2026-09-01) + คอลัมน์กระทบกับบิล */}
          <section className="stmt-section" ref={txnSectionRef}>
            <div className="stmt-upload-bar" style={{ marginBottom: 6 }}>
              <h3 className="stmt-h" style={{ margin: 0 }}>
                รายการธุรกรรม ({txns.filter(inMonth).length.toLocaleString("th-TH")}
                {monthFilter ? `/${txns.length.toLocaleString("th-TH")}` : ""}) — แก้ได้
              </h3>
              {monthFilter ? (
                <button
                  type="button"
                  className="btn"
                  style={{ background: "#eff6ff", borderColor: "#2563eb", color: "#1d4ed8" }}
                  onClick={() => {
                    setMonthFilter(null);
                    monthSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  📅 เฉพาะ {monthLabel(monthFilter)} — กดเพื่อดูทุกเดือน ✕
                </button>
              ) : null}
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
              accountant={accountant}
              chart={chart}
              accountPick={accountPick}
              accountSuggestions={accountSuggestions}
              onPickAccount={pickAccount}
              onClearAccount={clearAccount}
              reviewed={reviewed}
              manualPick={manualPick}
              uploadingRow={uploadingRow}
              filter={(t) => t.direction === "in" && inMonth(t)}
              updateTxn={updateTxn}
              onToggleReviewed={(k) =>
                setReviewed((prev) => {
                  const next = new Set(prev);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  return next;
                })
              }
              onManualPick={(k, b) => setManualPick((prev) => new Map(prev).set(k, b.id))}
              onUploadBill={(i, t, file) => void uploadBillForRow(i, t, file)}
            />
            <TxnPile
              title="🔻 กองเงินออก"
              tone="out"
              txns={txns}
              matches={matches}
              bills={bills}
              accountant={accountant}
              chart={chart}
              accountPick={accountPick}
              accountSuggestions={accountSuggestions}
              onPickAccount={pickAccount}
              onClearAccount={clearAccount}
              reviewed={reviewed}
              manualPick={manualPick}
              uploadingRow={uploadingRow}
              filter={(t) => t.direction === "out" && inMonth(t)}
              updateTxn={updateTxn}
              onToggleReviewed={(k) =>
                setReviewed((prev) => {
                  const next = new Set(prev);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  return next;
                })
              }
              onManualPick={(k, b) => setManualPick((prev) => new Map(prev).set(k, b.id))}
              onUploadBill={(i, t, file) => void uploadBillForRow(i, t, file)}
            />
            <TxnPile
              title="❔ ยังไม่ระบุทิศทาง"
              tone=""
              txns={txns}
              matches={matches}
              bills={bills}
              accountant={accountant}
              chart={chart}
              accountPick={accountPick}
              accountSuggestions={accountSuggestions}
              onPickAccount={pickAccount}
              onClearAccount={clearAccount}
              reviewed={reviewed}
              manualPick={manualPick}
              uploadingRow={uploadingRow}
              filter={(t) => t.direction !== "in" && t.direction !== "out" && inMonth(t)}
              updateTxn={updateTxn}
              onToggleReviewed={(k) =>
                setReviewed((prev) => {
                  const next = new Set(prev);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  return next;
                })
              }
              onManualPick={(k, b) => setManualPick((prev) => new Map(prev).set(k, b.id))}
              onUploadBill={(i, t, file) => void uploadBillForRow(i, t, file)}
              hideWhenEmpty
            />
            <p className="stmt-note">
              รายการถูกเซฟเข้า &ldquo;กระทบยอดธนาคาร&rdquo; ให้อัตโนมัติแล้ว (ดูสถานะที่แถบซ้าย) —
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

/** รูป/ไฟล์บิลแนบบนการ์ด — รูปโชว์ thumbnail กดดูเต็ม · PDF เป็นลิงก์เปิดดู */
function BillAttachment({ bill }: { bill: BillForMatch | undefined }) {
  if (!bill?.uploadUrl) return null;
  if (bill.uploadIsImage) {
    return (
      <a href={bill.uploadUrl} target="_blank" rel="noopener" title="กดดูรูปเต็ม" style={{ display: "inline-block", marginTop: 6 }}>
        {/* ★ perf 2026-09-01: thumbnail ผ่าน bill-thumb (ย่อฝั่ง storage + browser cache)
            — กดที่รูปค่อยเปิด signed URL ตัวเต็ม */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/accounting/bill-thumb?entry=${bill.id}&w=480`}
          alt="รูปบิล"
          loading="lazy"
          decoding="async"
          style={{ maxHeight: 120, maxWidth: "100%", borderRadius: 8, border: "1px solid #e2e8f0", display: "block" }}
        />
      </a>
    );
  }
  return (
    <a className="btn btn-ghost" href={bill.uploadUrl} target="_blank" rel="noopener" style={{ marginTop: 6, display: "inline-block" }}>
      📄 ดูไฟล์บิล ↗
    </a>
  );
}

/** การ์ดฝั่งขวา: ผลเทียบกับบิลในระบบของ 1 รายการ */
function BillSideCard({
  idx,
  rowKey,
  t,
  chart,
  accountPicked,
  accountSuggestion,
  onPickAccount,
  onClearAccount,
  match,
  matchesReady,
  bills,
  accountant,
  isReviewed,
  uploading,
  onToggleReviewed,
  onManualPick,
  onUploadBill,
}: {
  idx: number;
  rowKey: string;
  t: StatementTxn;
  chart: ChartAccount[];
  /** บัญชีที่นักบัญชีเลือกไว้ ("code|name") · null = ยังไม่เลือก */
  accountPicked: string | null;
  /** คำแนะนำจาก learning map (เฉพาะแถวไม่พบบิล) */
  accountSuggestion: AccountSuggestion;
  onPickAccount: (code: string, name: string) => void;
  onClearAccount: () => void;
  match: BillMatch | BillForMatch | null;
  matchesReady: boolean;
  bills: BillForMatch[];
  accountant: string | null;
  isReviewed: boolean;
  uploading: boolean;
  onToggleReviewed: (k: string) => void;
  onManualPick: (k: string, b: BillForMatch) => void;
  onUploadBill: (i: number, t: StatementTxn, file: File) => void;
}) {
  const [q, setQ] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
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
        <BillAttachment bill={bills.find((b) => b.id === billId)} />
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <a className="btn btn-ghost" href={`/chat-audit/accounting?edit=${billId}${accountant ? `&accountant=${encodeURIComponent(accountant)}` : ""}`} target="_blank" rel="noopener">
            เปิดบิล ↗
          </a>
          <button type="button" className={isReviewed ? "btn" : "btn btn-ghost"} onClick={() => onToggleReviewed(rowKey)}>
            {isReviewed ? "✓ ตรวจแล้ว" : "ติ๊กว่าตรวจแล้ว"}
          </button>
        </div>
      </div>
    );
  }

  // ไม่พบบิล — อัปบิลจริงเข้าแถวนี้ หรือค้นบิลจับคู่มือ (★ 2026-09-01 ผู้ใช้เลือกไม่สร้างบิลจากเงินเข้า
  //   อัตโนมัติ — "เดี๋ยวอัพบิลเพิ่มเอง" → เหลือปุ่มอัปบิล/ค้นบิล/ติ๊กไม่ต้องมีบิล)
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
      {/* ★ 2026-09-02 บัญชีคู่บนแถวกระทบยอด: 🤖 แนะนำจากที่เคยเรียนรู้ · นักบัญชีพิมพ์เลข/เลื่อนหา
          แก้ได้เอง (combobox เดียวกับหน้าตรวจ/แก้บิล) · เลือกแล้วระบบจำ + ใช้สอนการแนะนำรอบหน้า */}
      {(() => {
        const picked = accountPicked ? accountPicked.split("|") : null;
        const code = picked ? picked[0] : accountSuggestion?.code ?? "";
        const name = picked ? picked.slice(1).join("|") : accountSuggestion?.name ?? "";
        return (
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>บัญชี{t.direction === "in" ? " (รายได้)" : t.direction === "out" ? " (ค่าใช้จ่าย)" : ""}:</span>
            <div style={{ minWidth: 220, flex: 1 }}>
              <AccountCombobox
                accountCode={code}
                accountName={name}
                chart={chart}
                readOnly={false}
                onSelect={(c, n) => onPickAccount(c, n)}
                onNameChange={(n) => code && onPickAccount(code, n)}
                onClear={onClearAccount}
              />
            </div>
            {!picked && accountSuggestion ? (
              <span style={{ fontSize: 11, background: "#eff6ff", color: "#1d4ed8", borderRadius: 8, padding: "1px 8px" }}
                title="แนะนำจากที่นักบัญชีเคยเลือกให้ผู้โอนคนนี้ — เลือก/แก้เพื่อยืนยัน">
                🤖 แนะนำ
              </span>
            ) : null}
          </div>
        );
      })()}
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
        {/* อัปรูป/ไฟล์บิลจริงเข้าแถวนี้เลย (requirement 2026-09-01) — บิลใหม่จะจับคู่เองถ้ายอด/วันตรง */}
        <input
          ref={uploadRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUploadBill(idx, t, f);
            e.target.value = "";
          }}
        />
        <button type="button" className="btn" disabled={uploading} onClick={() => uploadRef.current?.click()}>
          {uploading ? "กำลังอัป + AI อ่านบิล…" : "📷 อัปรูปบิลแถวนี้"}
        </button>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นบิลด้วยชื่อ/เลขที่/ยอด…"
          style={{ maxWidth: 180 }}
        />
        <button type="button" className={isReviewed ? "btn" : "btn btn-ghost"} onClick={() => onToggleReviewed(rowKey)}>
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
              <button type="button" className="btn btn-ghost" onClick={() => onManualPick(rowKey, b)}>
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
  accountant,
  chart,
  accountPick,
  accountSuggestions,
  onPickAccount,
  onClearAccount,
  reviewed,
  manualPick,
  uploadingRow,
  filter,
  updateTxn,
  onToggleReviewed,
  onManualPick,
  onUploadBill,
  hideWhenEmpty = false,
}: {
  title: string;
  tone: "in" | "out" | "";
  txns: StatementTxn[];
  matches: (BillMatch | null)[] | null;
  bills: BillForMatch[];
  accountant: string | null;
  chart: ChartAccount[];
  accountPick: Map<string, string>;
  accountSuggestions: AccountSuggestion[] | null;
  onPickAccount: (k: string, t: StatementTxn, code: string, name: string) => void;
  onClearAccount: (k: string) => void;
  reviewed: Set<string>;
  manualPick: Map<string, string>;
  uploadingRow: number;
  filter: (t: StatementTxn) => boolean;
  updateTxn: (idx: number, patch: Partial<StatementTxn>) => void;
  onToggleReviewed: (k: string) => void;
  onManualPick: (k: string, b: BillForMatch) => void;
  onUploadBill: (i: number, t: StatementTxn, file: File) => void;
  hideWhenEmpty?: boolean;
}) {
  const rows = txns.map((t, i) => ({ t, i })).filter(({ t }) => filter(t));
  if (rows.length === 0 && hideWhenEmpty) return null;
  const total = rows.reduce((s, { t }) => s + (t.amount ?? 0), 0);
  const matchedCount = matches ? rows.filter(({ t, i }) => matches[i] || manualPick.has(txnKey(t))).length : 0;
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
            const k = txnKey(t);
            const manualId = manualPick.get(k);
            const manual = manualId ? bills.find((b) => b.id === manualId) ?? null : null;
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
                  rowKey={k}
                  t={t}
                  match={matches ? (manual ?? matches[i]) : null}
                  matchesReady={!!matches}
                  bills={bills}
                  accountant={accountant}
                  chart={chart}
                  accountPicked={accountPick.get(k) ?? null}
                  accountSuggestion={accountSuggestions ? accountSuggestions[i] ?? null : null}
                  onPickAccount={(code, name) => onPickAccount(k, t, code, name)}
                  onClearAccount={() => onClearAccount(k)}
                  isReviewed={reviewed.has(k)}
                  uploading={uploadingRow === i}
                  onToggleReviewed={onToggleReviewed}
                  onManualPick={onManualPick}
                  onUploadBill={onUploadBill}
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
        <p className="empty">ไม่มีรายการ (หรือระบุตัวผู้โอนไม่ได้)</p>
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
