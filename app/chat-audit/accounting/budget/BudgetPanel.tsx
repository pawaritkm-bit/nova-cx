"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveBudgetYearAction } from "./actions";
import { searchChartNonBankGrouped, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";
import type { AccountBudget } from "@/lib/accounting/budget";
import { buildBudgetSaveRows } from "@/lib/accounting/budget-panel-helpers";

/**
 * BudgetPanel — กริดตั้งงบประมาณของลูกค้า 1 ราย 1 ปี (เฟส 6 ส่วน S)
 *   - ผังบัญชีทั้งหมด (จัดกลุ่มตามหมวด reuse searchChartNonBankGrouped) × 12 ช่องเดือน
 *   - กรอกตัวเลขอิสระต่อช่อง (ไม่บังคับกรอกครบทุกเดือน/ทุกบัญชี — 0.9)
 *   - บันทึกทีเดียวทั้งปี (0.12) ผ่าน saveBudgetYearAction (batch upsert — ทับของเดิมทั้งชุด)
 *
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope)
 * ★ pure client state ล้วน (ไม่มี auto-save ต่อช่อง) — กดปุ่ม "บันทึกงบทั้งปี" ครั้งเดียวจบ
 */

const MONTH_LABELS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

/** ตาราง accountCode -> เดือน(1-12, index 0-11) -> ข้อความในช่อง */
type Grid = Record<string, string[]>;

function buildInitialGrid(chart: ChartAccount[], budgetRows: AccountBudget[]): Grid {
  const grid: Grid = {};
  for (const a of chart) grid[a.code] = Array.from({ length: 12 }, () => "");
  for (const r of budgetRows) {
    if (!grid[r.accountCode]) grid[r.accountCode] = Array.from({ length: 12 }, () => "");
    if (r.month >= 1 && r.month <= 12 && r.amount) {
      grid[r.accountCode][r.month - 1] = String(r.amount);
    }
  }
  return grid;
}

/** บัญชีที่มีงบตั้งไว้แล้วอย่างน้อย 1 เดือน (ใช้กางกลุ่มเริ่มต้นให้เห็นของเดิม) */
function hasAnyBudget(grid: Grid, code: string): boolean {
  return (grid[code] ?? []).some((v) => parseAmountInput(v) > 0);
}

export default function BudgetPanel({
  customerId,
  year,
  chart,
  budgetRows,
}: {
  customerId: string;
  year: number;
  chart: ChartAccount[];
  budgetRows: AccountBudget[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [grid, setGrid] = useState<Grid>(() => buildInitialGrid(chart, budgetRows));
  // ★ รหัสบัญชีที่ผู้ใช้ "แก้ไข" ในรอบนี้ (ไม่ใช่แค่ amount>0) — ใช้ตัดสินว่าต้องส่งบัญชีไหนไป server บ้าง
  //   (บั๊กเดิม: กรองด้วย amount>0 เพียงอย่างเดียว ทำให้เคลียร์งบทั้งปีของบัญชีหนึ่งกลับเป็น 0 ไม่ได้จริง
  //   เพราะทุกแถวของบัญชีนั้นถูกกรองทิ้งหมด ไม่ถูกส่งไป server เลย — ดู lib/accounting/budget-panel-helpers.ts)
  const [dirty, setDirty] = useState<Set<string>>(new Set());

  const groups = useMemo(() => searchChartNonBankGrouped(chart, ""), [chart]);

  const setCell = (code: string, monthIdx: number, value: string) => {
    setGrid((prev) => {
      const row = prev[code] ? [...prev[code]] : Array.from({ length: 12 }, () => "");
      row[monthIdx] = value;
      return { ...prev, [code]: row };
    });
    setDirty((prev) => (prev.has(code) ? prev : new Set(prev).add(code)));
  };

  const rowTotal = (code: string): number =>
    (grid[code] ?? []).reduce((s, v) => s + parseAmountInput(v), 0);

  function save() {
    setMsg(null);
    // ★ ส่งครบ 12 เดือนของ "บัญชีที่แก้ไขจริงในรอบนี้" เท่านั้น (รวมช่อง amount=0/ว่างด้วย) — ไม่กรองด้วย
    //   amount>0 อย่างเดียวเหมือนเดิม เพื่อให้เคลียร์งบทั้งปีของบัญชีหนึ่งกลับเป็น 0 ได้จริง (server
    //   upsertBudgetYear ใช้รหัสบัญชีที่ปรากฏใน rows ตัดสินว่าต้องลบของเดิมของบัญชีไหนบ้าง)
    const rows = buildBudgetSaveRows(grid, dirty, parseAmountInput);
    startTransition(async () => {
      const res = await saveBudgetYearAction({ customerId, year, rows });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setDirty(new Set());
        router.refresh();
      }
    });
  }

  return (
    <div className="acc-je">
      <p className="muted" style={{ marginTop: 0 }}>
        กรอกงบประมาณรายเดือนของปี {year + 543} ต่อรหัสบัญชี (เว้นว่าง = ยังไม่ตั้งงบ ถือว่า 0) —
        กด “บันทึกงบทั้งปี” ครั้งเดียวเพื่อบันทึกทุกช่องพร้อมกัน
      </p>

      {groups.map((g) => {
        const groupHasBudget = g.accounts.some((a) => hasAnyBudget(grid, a.code));
        return (
          <details key={g.digit} className="acc-budget-group" open={g.digit === "4" || g.digit === "5" || groupHasBudget}>
            <summary>{g.category}</summary>
            <div className="table-wrap">
              <table className="dlv-table acc-table acc-budget-table">
                <thead>
                  <tr>
                    <th>รหัส</th>
                    <th>ชื่อบัญชี</th>
                    {MONTH_LABELS.map((m) => (
                      <th key={m} className="num">{m}</th>
                    ))}
                    <th className="num">รวมปี</th>
                  </tr>
                </thead>
                <tbody>
                  {g.accounts.map((a) => (
                    <tr key={a.code}>
                      <td className="mono acc-budget-code">{a.code}</td>
                      <td>{a.name}</td>
                      {MONTH_LABELS.map((_, idx) => (
                        <td key={idx} className="num">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={grid[a.code]?.[idx] ?? ""}
                            onChange={(e) => setCell(a.code, idx, e.target.value)}
                            placeholder="0.00"
                            disabled={pending}
                            aria-label={`${a.name} · ${MONTH_LABELS[idx]}`}
                          />
                        </td>
                      ))}
                      <td className="num strong">{formatMoney(rowTotal(a.code))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}

      <div className="acc-budget-actions">
        <button type="button" className="btn" onClick={save} disabled={pending}>
          {pending ? "กำลังบันทึก…" : "บันทึกงบทั้งปี"}
        </button>
        {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}
      </div>
    </div>
  );
}
