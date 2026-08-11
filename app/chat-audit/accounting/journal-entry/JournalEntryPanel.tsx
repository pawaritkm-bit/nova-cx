"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  saveManualEntryAction,
  confirmManualEntryAction,
  unconfirmManualEntryAction,
  deleteManualEntryAction,
} from "./actions";
import {
  isBalanced,
  MANUAL_DOC_TYPE_LABELS,
  type ManualDocType,
  type ManualJournalEntry,
} from "@/lib/accounting/manual-journal";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";
import AccountCombobox from "../AccountCombobox";

/**
 * JournalEntryPanel — ลงบันทึกบัญชีเอง (Manual Journal Entry: JV/PV/RV) ของลูกค้า 1 ราย
 *   - ฟอร์ม: หัวเอกสาร (ประเภท/วันที่/เลขที่/คำอธิบาย) + ตารางบรรทัด (บัญชี/รายละเอียด/เดบิต/เครดิต)
 *     แก้ได้ทีละบรรทัด — combobox เลือกบัญชีเดียวกับหน้าลงบัญชีปกติ (AccountCombobox)
 *   - เช็คสมดุลเดบิต=เครดิตแบบสด (client hint) ก่อนกดบันทึก — server validate ซ้ำเสมอ (ไม่เชื่อ client)
 *   - รายการเดิมของลูกค้ารายนี้: แก้ไข (เฉพาะ draft) / ยืนยัน / ยกเลิกการยืนยัน / ลบ
 *   - entry ที่ยืนยันแล้ว = แก้ไม่ได้ (ต้อง "ยกเลิกการยืนยัน" ก่อน — เหมือน pattern bill_entries.confirmed)
 *
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope + service-role)
 */

type LineRow = {
  key: string;
  accountCode: string;
  accountName: string;
  description: string;
  debit: string;
  credit: string;
};

let keySeq = 0;
function newKey(): string {
  keySeq += 1;
  return `n${keySeq}`;
}

function blankLine(): LineRow {
  return { key: newKey(), accountCode: "", accountName: "", description: "", debit: "", credit: "" };
}

function blankLines(): LineRow[] {
  return [blankLine(), blankLine()];
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** วันที่แบบไทย วว/ดด/ปปปป (พ.ศ.) — สำหรับแสดงในรายการเดิม */
function formatDateThai(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso ?? "";
}

function entryTotal(entry: ManualJournalEntry): number {
  return entry.lines.reduce((s, l) => s + (l.debit || 0), 0);
}

export default function JournalEntryPanel({
  customerId,
  initial,
  chart,
  fxLockedIds,
}: {
  customerId: string;
  initial: ManualJournalEntry[];
  /** ผังบัญชีของ tenant (โหลดจาก DB ครั้งเดียวโดย page.tsx) */
  chart: ChartAccount[];
  /**
   * เฟส 10b (0.13) — id ของ JE ที่เป็น revaluation_je_id/reversing_je_id ของ fx_period_revaluations ที่ยัง
   *   ไม่จบ cycle — ซ่อนปุ่ม "ยืนยัน"/"ยกเลิกยืนยัน" generic ของ JE เหล่านี้ (server ยัง defense-in-depth
   *   ปฏิเสธจริงอีกชั้นที่ actions.ts เสมอ ไม่ได้พึ่ง UI hint นี้เป็นการบังคับจริง) · undefined/[] = ไม่มี
   */
  fxLockedIds?: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const chartByCode = useMemo(() => buildChartByCode(chart), [chart]);
  const fxLockedSet = useMemo(() => new Set(fxLockedIds ?? []), [fxLockedIds]);

  // ---- form state (สร้างใหม่/แก้ไข) ----
  const [editingId, setEditingId] = useState<string | null>(null);
  const [docType, setDocType] = useState<ManualDocType>("JV");
  const [docDate, setDocDate] = useState<string>(todayIso());
  const [docNo, setDocNo] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<LineRow[]>(() => blankLines());

  const patchLine = (key: string, patch: Partial<LineRow>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const addLine = () => setLines((prev) => [...prev, blankLine()]);
  const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l.key !== key));

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const l of lines) {
      debit += parseAmountInput(l.debit);
      credit += parseAmountInput(l.credit);
    }
    return { debit, credit };
  }, [lines]);
  const balanced = useMemo(
    () => isBalanced(lines.map((l) => ({ debit: parseAmountInput(l.debit), credit: parseAmountInput(l.credit) }))),
    [lines]
  );

  const resetForm = () => {
    setEditingId(null);
    setDocType("JV");
    setDocDate(todayIso());
    setDocNo("");
    setMemo("");
    setLines(blankLines());
  };

  const startEdit = (entry: ManualJournalEntry) => {
    if (entry.status !== "draft") {
      setMsg({ ok: false, text: "รายการนี้ยืนยันแล้ว — กด “ยกเลิกการยืนยัน” ก่อนแก้ไข" });
      return;
    }
    setMsg(null);
    setEditingId(entry.id);
    setDocType(entry.docType);
    setDocDate(entry.docDate);
    setDocNo(entry.docNo ?? "");
    setMemo(entry.memo ?? "");
    setLines(
      entry.lines.length > 0
        ? entry.lines.map((l) => ({
            key: newKey(),
            accountCode: l.accountCode,
            accountName: l.accountName ?? "",
            description: l.description ?? "",
            debit: l.debit ? String(l.debit) : "",
            credit: l.credit ? String(l.credit) : "",
          }))
        : blankLines()
    );
  };

  function save(confirm: boolean) {
    setMsg(null);
    startTransition(async () => {
      const res = await saveManualEntryAction({
        id: editingId ?? undefined,
        customerId,
        docType,
        docDate,
        docNo: docNo || null,
        memo: memo || null,
        lines: lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName || null,
          description: l.description || null,
          debit: parseAmountInput(l.debit),
          credit: parseAmountInput(l.credit),
        })),
        confirm,
      });
      if (res.ok) {
        resetForm();
        setMsg({ ok: true, text: res.message });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.message });
      }
    });
  }

  function onConfirm(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await confirmManualEntryAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  function onUnconfirm(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await unconfirmManualEntryAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  function onDelete(id: string) {
    if (!window.confirm("ลบรายการนี้?")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteManualEntryAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        if (editingId === id) resetForm();
        router.refresh();
      }
    });
  }

  return (
    <div className="acc-je">
      {/* ---- ฟอร์ม สร้าง/แก้ไข ---- */}
      <div className="acc-je-form">
        <div className="acc-je-form-head">
          <span className="strong">{editingId ? "แก้ไขรายการ" : "สร้างรายการใหม่"}</span>
          {editingId ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={resetForm} disabled={pending}>
              + สร้างใหม่แทน
            </button>
          ) : null}
        </div>

        <div className="acc-field-grid">
          <label className="acc-field">
            <span>ประเภทเอกสาร</span>
            <select value={docType} onChange={(e) => setDocType(e.target.value as ManualDocType)} disabled={pending}>
              {(Object.keys(MANUAL_DOC_TYPE_LABELS) as ManualDocType[]).map((t) => (
                <option key={t} value={t}>
                  {MANUAL_DOC_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="acc-field">
            <span>วันที่เอกสาร</span>
            <input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} disabled={pending} />
          </label>
          <label className="acc-field">
            <span>เลขที่เอกสาร</span>
            <input
              type="text"
              value={docNo}
              onChange={(e) => setDocNo(e.target.value)}
              placeholder="เช่น JV-2569-001"
              maxLength={50}
              disabled={pending}
            />
          </label>
          <label className="acc-field acc-field-wide">
            <span>คำอธิบาย</span>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="เช่น ปรับปรุงค่าเสื่อมราคาประจำเดือน"
              maxLength={500}
              disabled={pending}
            />
          </label>
        </div>

        {/* ---- ตารางบรรทัด ---- */}
        <div className="acc-je-lines">
          <div className="acc-je-lines-head">
            <span>บัญชี</span>
            <span>รายละเอียด</span>
            <span className="num">เดบิต</span>
            <span className="num">เครดิต</span>
            <span />
          </div>
          {lines.map((l) => (
            <div className="acc-je-line" key={l.key}>
              <AccountCombobox
                accountCode={l.accountCode}
                accountName={l.accountName}
                chart={chart}
                readOnly={false}
                onSelect={(code, name) => patchLine(l.key, { accountCode: code, accountName: name })}
                onNameChange={(name) => patchLine(l.key, { accountName: name })}
                onClear={() => patchLine(l.key, { accountCode: "", accountName: "" })}
              />
              <input
                type="text"
                value={l.description}
                onChange={(e) => patchLine(l.key, { description: e.target.value })}
                placeholder="รายละเอียด (ไม่บังคับ)"
                maxLength={200}
                disabled={pending}
                aria-label="รายละเอียด"
              />
              <input
                className="num"
                inputMode="decimal"
                value={l.debit}
                onChange={(e) => patchLine(l.key, { debit: e.target.value, credit: e.target.value ? "" : l.credit })}
                placeholder="0.00"
                disabled={pending}
                aria-label="เดบิต"
              />
              <input
                className="num"
                inputMode="decimal"
                value={l.credit}
                onChange={(e) => patchLine(l.key, { credit: e.target.value, debit: e.target.value ? "" : l.debit })}
                placeholder="0.00"
                disabled={pending}
                aria-label="เครดิต"
              />
              <button
                type="button"
                className="acc-line-del"
                onClick={() => removeLine(l.key)}
                disabled={pending || lines.length <= 1}
                aria-label="ลบบรรทัด"
                title="ลบบรรทัด"
              >
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="acc-add-line" onClick={addLine} disabled={pending}>
            + เพิ่มบรรทัด
          </button>

          <div className="acc-je-line acc-je-total">
            <span className="strong">รวม</span>
            <span />
            <span className="num strong">{formatMoney(totals.debit)}</span>
            <span className="num strong">{formatMoney(totals.credit)}</span>
            <span />
          </div>
        </div>

        {!balanced ? (
          <div className="action-msg err">
            เดบิตรวม ({formatMoney(totals.debit)}) ไม่เท่ากับเครดิตรวม ({formatMoney(totals.credit)}) —
            ต้องสมดุลก่อนบันทึก
          </div>
        ) : null}
        {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}

        <div className="acc-modal-actions">
          <button type="button" className="btn" onClick={() => save(false)} disabled={pending || !balanced}>
            {pending ? "กำลังบันทึก…" : "บันทึกร่าง"}
          </button>
          <button type="button" className="btn green" onClick={() => save(true)} disabled={pending || !balanced}>
            บันทึกและยืนยัน
          </button>
        </div>
      </div>

      {/* ---- รายการเดิมของลูกค้ารายนี้ ---- */}
      <div className="acc-je-list">
        <div className="strong" style={{ marginBottom: 8 }}>
          รายการที่ลงไว้แล้ว {initial.length > 0 ? `(${initial.length})` : ""}
        </div>
        {initial.length === 0 ? (
          <p className="empty">ยังไม่มีรายการลงบัญชีเอง — สร้างรายการแรกด้านบน</p>
        ) : (
          <div className="table-wrap">
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>ประเภท</th>
                  <th>วันที่</th>
                  <th>เลขที่</th>
                  <th>คำอธิบาย</th>
                  <th className="num">ยอด</th>
                  <th>สถานะ</th>
                  <th>จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {initial.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.docType}</td>
                    <td>{formatDateThai(entry.docDate)}</td>
                    <td>{entry.docNo || "—"}</td>
                    <td>{entry.memo || "—"}</td>
                    <td className="num">{formatMoney(entryTotal(entry))}</td>
                    <td>{entry.status === "confirmed" ? "ยืนยันแล้ว" : "ร่าง"}</td>
                    <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {fxLockedSet.has(entry.id) ? (
                        // เฟส 10b (0.13) — JE นี้ผูกกับ fx revaluation ที่ยังไม่จบ cycle — ต้องจัดการผ่านหน้า
                        // "ปรับปรุงอัตราแลกเปลี่ยนปลายงวด" เท่านั้น (ปุ่มยืนยัน/ยกเลิกยืนยัน generic ถูกซ่อน)
                        <Link
                          href={`/chat-audit/accounting/fx-revaluation?customerId=${customerId}`}
                          className="btn btn-sm btn-ghost"
                        >
                          จัดการที่หน้า “ปรับปรุงอัตราแลกเปลี่ยนปลายงวด” →
                        </Link>
                      ) : entry.status === "draft" ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => startEdit(entry)}
                            disabled={pending}
                          >
                            แก้ไข
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm green"
                            onClick={() => onConfirm(entry.id)}
                            disabled={pending}
                          >
                            ยืนยัน
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => onUnconfirm(entry.id)}
                          disabled={pending}
                        >
                          ยกเลิกการยืนยัน
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm danger"
                        onClick={() => onDelete(entry.id)}
                        disabled={pending}
                      >
                        ลบ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
