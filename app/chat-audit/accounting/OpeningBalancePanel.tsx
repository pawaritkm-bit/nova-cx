"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import {
  upsertOpeningBalanceAction,
  deleteOpeningBalanceAction,
  importOpeningBalancesAction,
} from "./actions";
import {
  parseOpeningBalanceRows,
  sumOpeningBalances,
  type OpeningBalance,
  type ParsedOpeningRow,
} from "@/lib/accounting/opening-balance";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { formatMoney } from "@/lib/accounting/calc";

/**
 * OpeningBalancePanel — จัดการ "ยอดยกมาต่อบัญชี" ของลูกค้า 1 ราย
 *   - ตารางยอดยกมา (รหัส · ชื่อบัญชี · ยอดยกมา) แก้ได้ + เพิ่ม/ลบแถว
 *   - อัปโหลด .xlsx/.csv → parse → preview → กด import → upsert
 *   - แสดงผลรวม (บวก=เดบิตสุทธิ / ลบ=เครดิตสุทธิ) เช็คคร่าว ๆ ว่าสมดุลไหม
 *
 * ★ ยอดยกมาติดลบได้ (ยอดเครดิต เช่น เจ้าหนี้/ทุน/กำไรสะสม)
 * ★ ทุกการเขียนผ่าน server action (guard admin + customer scope + service-role)
 * ★ .xls เก่า (BIFF) อ่านไม่ได้ — รองรับ .xlsx/.csv เท่านั้น (แจ้งผู้ใช้)
 */

type Row = {
  key: string;
  id?: string;
  accountCode: string;
  accountName: string;
  openingBalance: string;
};

let seq = 0;
const newKey = () => `n${(seq += 1)}`;

function toRows(initial: OpeningBalance[]): Row[] {
  return initial.map((b) => ({
    key: b.id,
    id: b.id,
    accountCode: b.accountCode,
    accountName: b.accountName ?? "",
    openingBalance: b.openingBalance ? String(b.openingBalance) : "",
  }));
}

/** parse ค่าเงินจากช่อง input (รองรับ comma/ติดลบ) → number */
function toNum(v: string): number {
  const n = Number((v ?? "").replace(/[,\s฿]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** อ่านไฟล์ที่อัป → 2D grid (รองรับ .csv text + .xlsx ด้วย exceljs) */
async function fileToGrid(file: File): Promise<unknown[][]> {
  const name = file.name.toLowerCase();
  // CSV: อ่านเป็นข้อความแล้ว split (จัดการ quote แบบพื้นฐาน)
  if (name.endsWith(".csv") || file.type === "text/csv") {
    const text = await file.text();
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => parseCsvLine(line));
  }
  // XLSX: ใช้ exceljs (lazy import — ไม่ให้ bundle หน้าอื่น)
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const grid: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[]; // index 0 ว่างเสมอใน exceljs
    grid.push(values.slice(1));
  });
  return grid;
}

/** split บรรทัด CSV แบบรองรับ "..." ครอบ comma */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuote = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export default function OpeningBalancePanel({
  customerId,
  initial,
  chart,
}: {
  customerId: string;
  initial: OpeningBalance[];
  /** ผังบัญชีของ tenant (โหลดจาก DB ครั้งเดียวโดย opening/page.tsx) — เติมชื่อบัญชีอัตโนมัติ */
  chart: ChartAccount[];
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(initial));
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<ParsedOpeningRow[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const chartByCode = useMemo(() => buildChartByCode(chart), [chart]);

  const patch = (key: string, p: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const total = useMemo(
    () => sumOpeningBalances(rows.map((r) => ({ openingBalance: toNum(r.openingBalance) }))),
    [rows]
  );

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { key: newKey(), accountCode: "", accountName: "", openingBalance: "" },
    ]);
  };

  // เติมชื่อบัญชีอัตโนมัติจากผังกลางเมื่อพิมพ์รหัสที่รู้จัก (ถ้ายังไม่มีชื่อ)
  const onCodeChange = (row: Row, code: string) => {
    const name = !row.accountName && chartByCode[code.trim()]?.name;
    patch(row.key, name ? { accountCode: code, accountName: name } : { accountCode: code });
  };

  const saveRow = (row: Row) => {
    if (!row.accountCode.trim()) {
      setMsg({ ok: false, text: "ต้องระบุรหัสบัญชี" });
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await upsertOpeningBalanceAction({
        customerId,
        accountCode: row.accountCode,
        accountName: row.accountName || null,
        openingBalance: toNum(row.openingBalance),
      });
      setMsg({ ok: res.ok, text: res.message });
    });
  };

  const removeRow = (row: Row) => {
    if (!row.id) {
      setRows((prev) => prev.filter((r) => r.key !== row.key));
      return;
    }
    if (!window.confirm("ลบยอดยกมาบัญชีนี้?")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteOpeningBalanceAction(row.id!);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) setRows((prev) => prev.filter((r) => r.key !== row.key));
    });
  };

  // เลือกไฟล์ → parse → เก็บ preview (ยังไม่เขียน DB จนกด "นำเข้า")
  const onFile = async (file: File | null) => {
    if (!file) return;
    setMsg(null);
    setPreview(null);
    try {
      const grid = await fileToGrid(file);
      const parsed = parseOpeningBalanceRows(chartByCode, grid);
      if (parsed.length === 0) {
        setMsg({
          ok: false,
          text: "อ่านไฟล์ไม่พบข้อมูล — ต้องมีหัวคอลัมน์ 'รหัสบัญชี' และ 'ยอดยกมา' (.xlsx/.csv)",
        });
        return;
      }
      setPreview(parsed);
    } catch {
      setMsg({ ok: false, text: "อ่านไฟล์ไม่สำเร็จ — รองรับ .xlsx และ .csv (ไม่รองรับ .xls เก่า)" });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const doImport = () => {
    if (!preview || preview.length === 0) return;
    setMsg(null);
    startTransition(async () => {
      const res = await importOpeningBalancesAction({ customerId, rows: preview });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        // แทนที่ตารางด้วยข้อมูลที่ import (ให้เห็นผลทันที — id จริงจะได้จาก refresh หน้า)
        setRows(
          preview.map((p) => ({
            key: newKey(),
            accountCode: p.accountCode,
            accountName: p.accountName ?? "",
            openingBalance: p.openingBalance ? String(p.openingBalance) : "",
          }))
        );
        setPreview(null);
      }
    });
  };

  const previewTotal = preview ? sumOpeningBalances(preview) : 0;

  return (
    <div className="acc-opening">
      <p className="acc-bank-hint">
        ยอดยกมาต้นงวดต่อบัญชีของลูกค้ารายนี้ (ใช้เตรียมออกงบการเงิน). ยอดติดลบ = ยอดฝั่งเครดิต
        (เช่น เจ้าหนี้ / ทุน / กำไรสะสม).
      </p>

      {/* อัปโหลดไฟล์ */}
      <div className="acc-opening-upload">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          disabled={pending}
          aria-label="อัปโหลดไฟล์ยอดยกมา"
        />
        <span className="acc-opening-upload-hint">รองรับ .xlsx / .csv (คอลัมน์: รหัสบัญชี, ชื่อบัญชี, ยอดยกมา)</span>
      </div>

      {/* preview ก่อน import */}
      {preview ? (
        <div className="acc-opening-preview">
          <div className="acc-opening-preview-head">
            พบ {preview.length} บัญชี · รวม {formatMoney(previewTotal)}
          </div>
          <div className="acc-opening-preview-list">
            {preview.slice(0, 50).map((p, i) => (
              <div className="acc-opening-preview-row" key={`${p.accountCode}-${i}`}>
                <span className="mono">{p.accountCode}</span>
                <span>{p.accountName || "—"}</span>
                <span className="num">{formatMoney(p.openingBalance)}</span>
              </div>
            ))}
            {preview.length > 50 ? (
              <div className="acc-opening-preview-more">…และอีก {preview.length - 50} บัญชี</div>
            ) : null}
          </div>
          <div className="acc-modal-actions">
            <button type="button" className="btn green" onClick={doImport} disabled={pending}>
              {pending ? "กำลังนำเข้า…" : `นำเข้า ${preview.length} บัญชี`}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setPreview(null)}
              disabled={pending}
            >
              ยกเลิก
            </button>
          </div>
        </div>
      ) : null}

      {/* ตารางแก้ไข */}
      <div className="acc-opening-list">
        <div className="acc-opening-row acc-opening-head">
          <span>รหัสบัญชี</span>
          <span>ชื่อบัญชี</span>
          <span className="num">ยอดยกมา</span>
          <span />
        </div>
        {rows.length === 0 ? (
          <div className="acc-bank-empty">ยังไม่มียอดยกมา — กด “＋ เพิ่มบัญชี” หรืออัปโหลดไฟล์</div>
        ) : (
          rows.map((row) => (
            <div className="acc-opening-row" key={row.key}>
              <input
                type="text"
                className="mono"
                value={row.accountCode}
                onChange={(e) => onCodeChange(row, e.target.value)}
                placeholder="เช่น 1010"
                maxLength={20}
                disabled={pending}
                aria-label="รหัสบัญชี"
              />
              <input
                type="text"
                value={row.accountName}
                onChange={(e) => patch(row.key, { accountName: e.target.value })}
                placeholder="ชื่อบัญชี"
                maxLength={200}
                disabled={pending}
                aria-label="ชื่อบัญชี"
              />
              <input
                type="text"
                className="num"
                inputMode="decimal"
                value={row.openingBalance}
                onChange={(e) => patch(row.key, { openingBalance: e.target.value })}
                placeholder="0.00"
                disabled={pending}
                aria-label="ยอดยกมา"
              />
              <span className="acc-opening-row-actions">
                <button
                  type="button"
                  className="btn acc-bank-save"
                  onClick={() => saveRow(row)}
                  disabled={pending}
                  title="บันทึกบัญชีนี้"
                >
                  บันทึก
                </button>
                <button
                  type="button"
                  className="acc-line-del"
                  onClick={() => removeRow(row)}
                  disabled={pending}
                  aria-label="ลบ"
                  title="ลบ"
                >
                  ✕
                </button>
              </span>
            </div>
          ))
        )}
        {/* แถวรวม */}
        <div className="acc-opening-row acc-opening-total">
          <span className="strong">รวม</span>
          <span />
          <span className="num strong">{formatMoney(total)}</span>
          <span />
        </div>
      </div>

      <button type="button" className="acc-add-line" onClick={addRow} disabled={pending}>
        ＋ เพิ่มบัญชี
      </button>

      {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}
    </div>
  );
}
