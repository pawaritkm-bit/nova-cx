"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  createPlatformReportUploadUrlAction,
  getPlatformReportSettingsAction,
  savePlatformReportSettingsAction,
  createPlatformReportDraftJournalEntryAction,
} from "./platform-report-actions";
import { createClient as createBrowserSupabase } from "@/lib/supabase/client";
import { UPLOAD_ACCEPT, MAX_UPLOAD_BYTES, validateUpload } from "@/lib/accounting/upload";
import {
  summarizePlatformReport,
  summarizePlatformReportByMonth,
  PLATFORM_CATEGORY_LABEL,
  type PlatformReportLine,
  type PlatformCategory,
  type PlatformLineDirection,
} from "@/lib/accounting/platform-report-analyze";
import { toCsv } from "@/lib/accounting/csv-export";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";
import type { PlatformReportSettings } from "@/lib/accounting/platform-report-settings";
import AccountCombobox from "./AccountCombobox";

/** bucket เดียวกับบิล/สเตทเมนต์ (ต้องตรงกับ PLATFORM_REPORT actions / route) */
const BILLS_BUCKET = "bills";

/** จำนวนไฟล์สูงสุดต่อ "รอบอัปโหลด" — อัปได้หลายรอบต่อกัน ผลลัพธ์จะถูกรวมเข้ากับรอบก่อนหน้า (ดู submit()) */
const MAX_FILES = 20;
/** จำนวนไฟล์ที่ประมวลผลพร้อมกันสูงสุด (คุมยอดรวม concurrent request ไป OpenAI ไม่ให้พุ่งเกินควร) */
const FILE_CONCURRENCY = 3;

type ReportMeta = {
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
  lines: PlatformReportLine[];
  meta: ReportMeta;
};

const CATEGORY_OPTIONS: PlatformCategory[] = [
  "sales",
  "commission_fee",
  "payment_fee",
  "shipping_fee",
  "ads_fee",
  "penalty",
  "refund",
  "other",
];

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

/** ★ 2026-08-12 — ตั้งค่าบัญชี (ประเภทรายงานแพลตฟอร์ม → รหัสบัญชี) สำหรับ auto-สร้างสมุดรายวันดราฟต์
 *   เก็บทั้ง code+name เพื่อแสดงผลใน AccountCombobox (mirror pattern payroll-employees settings form) */
type SettingsForm = {
  salesAccountCode: string;
  salesAccountName: string;
  commissionFeeAccountCode: string;
  commissionFeeAccountName: string;
  paymentFeeAccountCode: string;
  paymentFeeAccountName: string;
  shippingFeeAccountCode: string;
  shippingFeeAccountName: string;
  adsFeeAccountCode: string;
  adsFeeAccountName: string;
  penaltyAccountCode: string;
  penaltyAccountName: string;
  refundAccountCode: string;
  refundAccountName: string;
  otherAccountCode: string;
  otherAccountName: string;
  clearingAccountCode: string;
  clearingAccountName: string;
};

function accountNameFor(code: string, chart: ChartAccount[]): string {
  return chart.find((a) => a.code === code)?.name ?? "";
}

function settingsToForm(s: PlatformReportSettings, chart: ChartAccount[]): SettingsForm {
  return {
    salesAccountCode: s.salesAccountCode,
    salesAccountName: accountNameFor(s.salesAccountCode, chart),
    commissionFeeAccountCode: s.commissionFeeAccountCode,
    commissionFeeAccountName: accountNameFor(s.commissionFeeAccountCode, chart),
    paymentFeeAccountCode: s.paymentFeeAccountCode,
    paymentFeeAccountName: accountNameFor(s.paymentFeeAccountCode, chart),
    shippingFeeAccountCode: s.shippingFeeAccountCode,
    shippingFeeAccountName: accountNameFor(s.shippingFeeAccountCode, chart),
    adsFeeAccountCode: s.adsFeeAccountCode,
    adsFeeAccountName: accountNameFor(s.adsFeeAccountCode, chart),
    penaltyAccountCode: s.penaltyAccountCode,
    penaltyAccountName: accountNameFor(s.penaltyAccountCode, chart),
    refundAccountCode: s.refundAccountCode,
    refundAccountName: accountNameFor(s.refundAccountCode, chart),
    otherAccountCode: s.otherAccountCode,
    otherAccountName: accountNameFor(s.otherAccountCode, chart),
    clearingAccountCode: s.clearingAccountCode,
    clearingAccountName: accountNameFor(s.clearingAccountCode, chart),
  };
}

/** วันที่ล่าสุดจากรายการ (YYYY-MM-DD) — fallback วันนี้ถ้าไม่มีวันที่เลย · ใช้เป็น docDate ของ JE ที่สร้าง */
function latestDateOrToday(lines: PlatformReportLine[]): string {
  const dates = lines.map((l) => l.date).filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0) return new Date().toISOString().slice(0, 10);
  return dates.reduce((a, b) => (a > b ? a : b));
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
 * แผง "อ่านรายงานแพลตฟอร์ม" (ข้อ C) — แยกยอดขาย/ค่าธรรมเนียมแพลตฟอร์มออกจากกัน ให้เหลือกำไรจริง
 *   สถาปัตยกรรมเดียวกับ StatementAnalyzer.tsx ทั้งหมด (อัปหลายไฟล์/หลายรอบ, chunking ฝั่ง server,
 *   สถานะรายไฟล์, ตารางแก้ได้) — ต่างกันแค่ schema (ยอดขาย/ค่าธรรมเนียมแยกประเภท ไม่ใช่เงินเข้า-ออก)
 */
export default function PlatformReportAnalyzer({
  customerId,
  customerLabel,
  chart,
}: {
  customerId: string;
  customerLabel: string;
  chart: ChartAccount[];
}) {
  const [pending, startTransition] = useTransition();
  const [phase, setPhase] = useState<"" | "reading">("");
  const [err, setErr] = useState<string | null>(null);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [lines, setLines] = useState<PlatformReportLine[]>([]);
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // ★ ตั้งค่าบัญชี (ประเภท → รหัสบัญชี) + auto-สร้างสมุดรายวันดราฟต์ — โหลดตอน mount (เฉพาะลูกค้านี้)
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null);
  const [settingsMsg, setSettingsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [jeMsg, setJeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingSettings, startSettingsTransition] = useTransition();
  const [creatingJe, startJeTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    getPlatformReportSettingsAction(customerId).then((res) => {
      if (cancelled) return;
      if (res.ok) setSettingsForm(settingsToForm(res.settings, chart));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  function saveSettings() {
    if (!settingsForm) return;
    setSettingsMsg(null);
    startSettingsTransition(async () => {
      const res = await savePlatformReportSettingsAction({ customerId, ...settingsForm });
      setSettingsMsg({ ok: res.ok, text: res.ok ? res.message : res.message });
    });
  }

  function createDraftJournalEntry() {
    setJeMsg(null);
    startJeTransition(async () => {
      const res = await createPlatformReportDraftJournalEntryAction({
        customerId,
        docDate: latestDateOrToday(lines),
        summary,
      });
      setJeMsg({
        ok: res.ok,
        text: res.ok
          ? "สร้างสมุดรายวัน (ดราฟต์) แล้ว — ไปตรวจสอบ/ยืนยันที่หน้า \"ลงบันทึกบัญชีเอง\""
          : res.message,
      });
    });
  }

  // สรุปกำไรสุทธิ + รายเดือน คำนวณใหม่ทุกครั้งที่ตารางเปลี่ยน (helper เดียวกับ server) — รวมทุกไฟล์แล้ว
  const summary = useMemo(() => summarizePlatformReport(lines), [lines]);
  const monthly = useMemo(() => summarizePlatformReportByMonth(lines), [lines]);

  function updateLine(idx: number, patch: Partial<PlatformReportLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  /** อัปโหลด + อ่านไฟล์เดียวจบ (1 ไฟล์ = 1 signed URL + 1 เรียก extract-platform-report) */
  async function processOneFile(file: File): Promise<FileResult> {
    const prep = await createPlatformReportUploadUrlAction({
      customerId,
      fileName: file.name,
      mime: file.type,
      size: file.size,
    });
    if (!prep.ok) {
      return { fileName: file.name, ok: false, errorMessage: prep.message, lines: [], meta: null };
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
          lines: [],
          meta: null,
        };
      }
    } catch {
      return { fileName: file.name, ok: false, errorMessage: "อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่", lines: [], meta: null };
    }

    try {
      const res = await fetch("/api/accounting/extract-platform-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: prep.path, customerId, fileName: file.name }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; lines?: PlatformReportLine[]; meta?: ReportMeta }
        | null;
      if (!res.ok || !data?.ok) {
        return { fileName: file.name, ok: false, errorMessage: "อ่านรายงานไม่สำเร็จ กรุณาลองใหม่", lines: [], meta: null };
      }
      return {
        fileName: file.name,
        ok: true,
        lines: Array.isArray(data.lines) ? data.lines : [],
        meta: data.meta ?? null,
      };
    } catch {
      return { fileName: file.name, ok: false, errorMessage: "อ่านรายงานไม่สำเร็จ กรุณาลองใหม่", lines: [], meta: null };
    }
  }

  function submit() {
    const files = fileRef.current?.files ? Array.from(fileRef.current.files) : [];
    if (files.length === 0) {
      setErr("กรุณาเลือกไฟล์รายงานอย่างน้อย 1 ไฟล์");
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
      // รวมผลรอบนี้เข้ากับรอบก่อนหน้า (ไม่ทับ) เพื่อรองรับอัปโหลดหลายรอบต่อกัน
      setFileResults((prev) => [...prev, ...results]);
      setLines((prev) => [...prev, ...results.filter((r) => r.ok).flatMap((r) => r.lines)]);
      setSelectedNames([]);
      if (fileRef.current) fileRef.current.value = "";
      setDone(true);
      setPhase("");
    });
  }

  function clearAll() {
    setFileResults([]);
    setLines([]);
    setSelectedNames([]);
    setDone(false);
    setErr(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  /** ดาวน์โหลดตารางรายการที่แสดงอยู่ (รวมส่วนที่แก้ไขเองแล้ว) เป็น CSV — ยังไม่ persist ลง DB
   *  จึงต้อง export จากสิ่งที่แสดงบนจอตรง ๆ */
  function exportCsv() {
    const csv = toCsv(
      ["วันที่", "เลขคำสั่งซื้อ", "รายละเอียด", "ประเภท", "ทิศทาง", "ยอดเงิน"],
      lines.map((l) => [
        l.date,
        l.order_no,
        l.description,
        l.category ? PLATFORM_CATEGORY_LABEL[l.category] : "",
        l.direction === "credit" ? "เครดิต (ได้รับ)" : l.direction === "deduct" ? "หัก (ถูกตัด)" : "",
        l.amount,
      ])
    );
    downloadCsv(`platform-report-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  }

  const successCount = fileResults.filter((r) => r.ok).length;
  const hasAnyIssue = fileResults.some((r) => !r.ok || r.meta?.truncated || (r.meta?.failedChunks ?? 0) > 0);
  // เตือนถ้าไฟล์ที่เลือกรอบนี้ชื่อซ้ำกับไฟล์ที่อ่านสำเร็จไปแล้วในรอบก่อน (ดูคอมเมนต์เดียวกันใน StatementAnalyzer.tsx)
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
        <button type="button" className="btn" onClick={submit} disabled={pending}>
          {phase === "reading" ? "กำลังอัปโหลด + AI กำลังอ่าน…" : "อัปรายงาน + แยกยอดขาย/ค่าธรรมเนียม"}
        </button>
        {fileResults.length > 0 ? (
          <button type="button" className="btn btn-ghost" onClick={clearAll} disabled={pending}>
            ล้างรายการทั้งหมด
          </button>
        ) : null}
        {lines.length > 0 ? (
          <button type="button" className="btn btn-ghost" onClick={exportCsv}>
            ดาวน์โหลด CSV
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? "ปิดตั้งค่าบัญชี" : "⚙ ตั้งค่าบัญชี"}
        </button>
      </div>

      {/* ตั้งค่าบัญชี (ประเภทรายงานแพลตฟอร์ม → รหัสบัญชี) — ใช้ตอน auto-สร้างสมุดรายวันดราฟต์ */}
      {showSettings ? (
        <section className="stmt-section">
          <h3 className="stmt-h">ตั้งค่าบัญชี (ผูกครั้งเดียว ใช้ทุกครั้งที่สร้างสมุดรายวัน)</h3>
          {!settingsForm ? (
            <p className="empty">กำลังโหลด…</p>
          ) : (
            <>
              <div className="acc-field-grid">
                {(
                  [
                    ["salesAccountCode", "salesAccountName", "ยอดขาย (รายได้)"],
                    ["commissionFeeAccountCode", "commissionFeeAccountName", "ค่าคอมมิชชั่นแพลตฟอร์ม (ค่าใช้จ่าย)"],
                    ["paymentFeeAccountCode", "paymentFeeAccountName", "ค่าธรรมเนียมการรับเงิน (ค่าใช้จ่าย)"],
                    ["shippingFeeAccountCode", "shippingFeeAccountName", "ค่าส่ง/ค่าขนส่ง (ค่าใช้จ่าย)"],
                    ["adsFeeAccountCode", "adsFeeAccountName", "ค่าโฆษณา/โปรโมท (ค่าใช้จ่าย)"],
                    ["penaltyAccountCode", "penaltyAccountName", "ค่าปรับ (ค่าใช้จ่าย)"],
                    ["refundAccountCode", "refundAccountName", "เงินคืน/ยกเลิกออเดอร์ (หักจากยอดขาย)"],
                    ["otherAccountCode", "otherAccountName", "อื่นๆ (ค่าใช้จ่าย)"],
                    ["clearingAccountCode", "clearingAccountName", "เงินที่ได้รับจริง (เงินสด/ธนาคาร)"],
                  ] as [keyof SettingsForm, keyof SettingsForm, string][]
                ).map(([codeKey, nameKey, label]) => (
                  <label className="acc-field" key={codeKey}>
                    <span>{label}</span>
                    <AccountCombobox
                      accountCode={settingsForm[codeKey]}
                      accountName={settingsForm[nameKey]}
                      chart={chart}
                      readOnly={false}
                      onSelect={(code, name) =>
                        setSettingsForm((f) => (f ? { ...f, [codeKey]: code, [nameKey]: name } : f))
                      }
                      onNameChange={(name) => setSettingsForm((f) => (f ? { ...f, [nameKey]: name } : f))}
                      onClear={() =>
                        setSettingsForm((f) => (f ? { ...f, [codeKey]: "", [nameKey]: "" } : f))
                      }
                    />
                  </label>
                ))}
              </div>
              <button type="button" className="btn" onClick={saveSettings} disabled={savingSettings} style={{ marginTop: 10 }}>
                {savingSettings ? "กำลังบันทึก…" : "บันทึกตั้งค่า"}
              </button>
              {settingsMsg ? (
                <div className={`action-msg ${settingsMsg.ok ? "ok" : "err"}`}>{settingsMsg.text}</div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      {selectedNames.length > 0 ? (
        <div className="stmt-fname">
          เลือกไว้ {selectedNames.length} ไฟล์: {selectedNames.join(", ")}
        </div>
      ) : null}
      {duplicateNames.length > 0 ? (
        <div className="action-msg warn">
          ⚠ ชื่อไฟล์นี้เคยอ่านสำเร็จไปแล้ว: {duplicateNames.join(", ")} — ถ้าอัปซ้ำ รายการจะถูกนับซ้ำสองรอบ
        </div>
      ) : null}
      {err ? <div className="action-msg err">{err}</div> : null}

      {phase === "reading" ? (
        <div className="stmt-reading">
          AI กำลังอ่านรายงาน {selectedNames.length > 1 ? `ทั้ง ${selectedNames.length} ไฟล์` : ""}และแยกยอดขาย/ค่าธรรมเนียม…
          (ไฟล์ยาว/หลายไฟล์อาจใช้เวลาสักครู่)
        </div>
      ) : null}

      {/* สถานะรายไฟล์ (สำเร็จ/ล้มเหลว/ตัดข้อมูล/ชุดล้มเหลวบางส่วน) */}
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
                    — อ่าน {r.lines.length.toLocaleString("th-TH")} รายการ (ไฟล์ใหญ่เกินประมวลผลได้ในครั้งเดียว —
                    อ่านไป {r.meta.includedRows.toLocaleString("th-TH")} จาก {r.meta.totalRows.toLocaleString("th-TH")} แถว
                    ลองแบ่งไฟล์เป็นช่วงเวลาสั้นลง)
                  </span>
                ) : r.meta && r.meta.failedChunks > 0 ? (
                  <span>
                    — อ่านได้บางส่วน ({r.meta.chunkCount - r.meta.failedChunks}/{r.meta.chunkCount} ชุดสำเร็จ) ลองอัปโหลด
                    ไฟล์นี้ใหม่อีกครั้ง
                  </span>
                ) : r.lines.length === 0 ? (
                  <span>— อ่านไม่พบรายการ</span>
                ) : (
                  <span>— อ่านสำเร็จ {r.lines.length.toLocaleString("th-TH")} รายการ</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {done && lines.length === 0 && !hasAnyIssue ? (
        <div className="card"><p className="empty">อ่านไม่พบรายการในรายงาน ลองไฟล์อื่น หรือตรวจว่าเป็นรายงานสรุปยอดขาย/settlement จริง</p></div>
      ) : null}

      {lines.length > 0 ? (
        <>
          {/* สรุปกำไรสุทธิ + ค่าธรรมเนียมแยกประเภท (รวมทุกไฟล์) */}
          <section className="stmt-section">
            <h3 className="stmt-h">สรุปยอดขาย/ค่าธรรมเนียม{fileResults.length > 1 ? " (รวมทุกไฟล์)" : ""}</h3>
            <div className="stmt-month-cards">
              <div className="stmt-month-card">
                <div className="stmt-month-title">ยอดขายรวม</div>
                <div className="stmt-month-row in">
                  <span>ยอดขาย</span>
                  <b>{money(summary.grossSales)}</b>
                </div>
                {summary.otherCredit > 0 ? (
                  <div className="stmt-month-row in">
                    <span>เงินปรับปรุงเพิ่มอื่น ๆ</span>
                    <b>{money(summary.otherCredit)}</b>
                  </div>
                ) : null}
                <div className="stmt-month-net">
                  <span>รวมเงินที่ควรได้รับ</span>
                  <b>{money(summary.grossSales + summary.otherCredit)}</b>
                </div>
              </div>
              {summary.deductions.map((d) => (
                <div key={d.category} className="stmt-month-card">
                  <div className="stmt-month-title">{PLATFORM_CATEGORY_LABEL[d.category]}</div>
                  <div className="stmt-month-row out">
                    <span>ถูกหัก ({d.count} รายการ)</span>
                    <b>{money(d.total)}</b>
                  </div>
                </div>
              ))}
              <div className="stmt-month-card">
                <div className="stmt-month-title">กำไรสุทธิ (เงินที่ได้รับจริง)</div>
                <div className="stmt-month-row out">
                  <span>ค่าธรรมเนียม/หักรวม</span>
                  <b>{money(summary.totalDeductions)}</b>
                </div>
                <div className="stmt-month-net">
                  <span>กำไรสุทธิ</span>
                  <b>{money(summary.netAmount)}</b>
                </div>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn" onClick={createDraftJournalEntry} disabled={creatingJe}>
                {creatingJe ? "กำลังสร้าง…" : "สร้างสมุดรายวัน (ดราฟต์)"}
              </button>
              <p className="stmt-note" style={{ marginTop: 4 }}>
                สร้างเป็น &quot;ดราฟต์&quot; เสมอ — ไม่ auto-ยืนยัน ต้องไปตรวจสอบ/ยืนยันเองที่หน้า &quot;ลงบันทึกบัญชีเอง&quot; ก่อนจึงจะมีผลกับยอดบัญชีจริง
              </p>
              {jeMsg ? <div className={`action-msg ${jeMsg.ok ? "ok" : "err"}`}>{jeMsg.text}</div> : null}
            </div>
          </section>

          {/* สรุปรายเดือน (รวมทุกไฟล์) */}
          {monthly.length > 1 ? (
            <section className="stmt-section">
              <h3 className="stmt-h">สรุปรายเดือน{fileResults.length > 1 ? " (รวมทุกไฟล์)" : ""}</h3>
              <div className="stmt-month-cards">
                {monthly.map((m) => (
                  <div key={m.month || "none"} className="stmt-month-card">
                    <div className="stmt-month-title">{monthLabel(m.month)}</div>
                    <div className="stmt-month-row in">
                      <span>ยอดขาย/เครดิต</span>
                      <b>{money(m.grossSales)}</b>
                    </div>
                    <div className="stmt-month-row out">
                      <span>ค่าธรรมเนียม/หัก</span>
                      <b>{money(m.totalDeductions)}</b>
                    </div>
                    <div className="stmt-month-net">
                      <span>กำไรสุทธิ</span>
                      <b>{money(m.netAmount)}</b>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* ตารางรายการ (แก้ได้) */}
          <section className="stmt-section">
            <h3 className="stmt-h">รายการทั้งหมด ({lines.length}) — แก้ได้</h3>
            <div className="stmt-table-wrap">
              <table className="stmt-table">
                <thead>
                  <tr>
                    <th>วันที่</th>
                    <th>เลขคำสั่งซื้อ</th>
                    <th>รายละเอียด</th>
                    <th>ประเภท</th>
                    <th>ทิศทาง</th>
                    <th className="num">ยอดเงิน</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className={l.direction === "credit" ? "in" : l.direction === "deduct" ? "out" : ""}>
                      <td>
                        <input
                          type="text"
                          value={l.date ?? ""}
                          placeholder="YYYY-MM-DD"
                          onChange={(e) => updateLine(i, { date: e.target.value || null })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={l.order_no ?? ""}
                          onChange={(e) => updateLine(i, { order_no: e.target.value || null })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={l.description ?? ""}
                          onChange={(e) => updateLine(i, { description: e.target.value || null })}
                        />
                      </td>
                      <td>
                        <select
                          value={l.category ?? ""}
                          onChange={(e) =>
                            updateLine(i, { category: (e.target.value || null) as PlatformCategory | null })
                          }
                        >
                          <option value="">—</option>
                          {CATEGORY_OPTIONS.map((c) => (
                            <option key={c} value={c}>
                              {PLATFORM_CATEGORY_LABEL[c]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={l.direction ?? ""}
                          onChange={(e) =>
                            updateLine(i, { direction: (e.target.value || null) as PlatformLineDirection | null })
                          }
                        >
                          <option value="">—</option>
                          <option value="credit">เครดิต (ได้รับ)</option>
                          <option value="deduct">หัก (ถูกตัด)</option>
                        </select>
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          step="0.01"
                          value={l.amount ?? ""}
                          onChange={(e) => {
                            const n = e.target.value === "" ? null : Number(e.target.value);
                            updateLine(i, { amount: n != null && Number.isFinite(n) ? n : null });
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="stmt-note">
              ผลนี้ยังไม่บันทึกลงระบบบัญชี (ดู/สรุปเท่านั้น) — โหลดใหม่แล้วข้อมูลจะหาย
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
