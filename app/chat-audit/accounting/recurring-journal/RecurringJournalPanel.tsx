"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveTemplateAction,
  toggleTemplateActiveAction,
  deleteTemplateAction,
  generateNowAction,
} from "./actions";
import {
  FREQUENCY_LABELS,
  nextRunDateAfter,
  type Frequency,
  type RecurringTemplate,
  type RecurringOccurrence,
  type GenerationLogEntry,
} from "@/lib/accounting/recurring-journal";
import { isBalanced, MANUAL_DOC_TYPE_LABELS, type ManualDocType } from "@/lib/accounting/manual-journal";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";
import AccountCombobox from "../AccountCombobox";

/**
 * RecurringJournalPanel — ตั้ง/แก้/เปิดปิด/ลบเทมเพลตรายการบันทึกซ้ำของลูกค้า 1 ราย (เฟส 6 ส่วน R)
 *   - ฟอร์ม: หัวเทมเพลต (ประเภทเอกสาร/ความถี่/วันเริ่ม/วันสิ้นสุด/คำอธิบาย) + ตารางบรรทัด (เดบิต/เครดิต
 *     คงที่ทุกรอบ — 0.6) — combobox เลือกบัญชีเดียวกับหน้าลงบัญชีเอง (AccountCombobox)
 *   - เช็คสมดุลเดบิต=เครดิตแบบสด (client hint) ก่อนกดบันทึก — server validate ซ้ำเสมอ (ไม่เชื่อ client)
 *   - รายการเทมเพลตเดิม: แก้ไข / เปิด-ปิดใช้งาน / ลบ (soft-delete) / "สร้างตอนนี้" (บังคับ today ฝั่ง server)
 *   - occurrence ที่สร้างแล้วของแต่ละเทมเพลต: badge "สร้างจากรายการซ้ำ" + ลิงก์ไปหน้าลงบันทึกบัญชีเอง
 *   - ประวัติการสร้าง (log) — โชว์เหตุผลที่ล้มเหลว (0.8) ให้เห็นชัดเจน ไม่เงียบหาย
 *
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope + service-role)
 * ★ 0.3 ไม่มีปุ่ม "ยืนยัน" ในหน้านี้ — occurrence ที่สร้างเป็น draft เสมอ ต้องไปยืนยันที่หน้าลงบันทึกบัญชีเอง
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

/** วันที่แบบไทย วว/ดด/ปปปป (พ.ศ.) */
function formatDateThai(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso ?? "—";
}

function templateTotal(t: RecurringTemplate): number {
  return t.lines.reduce((s, l) => s + (l.debit || 0), 0);
}

const FREQUENCIES: Frequency[] = ["monthly", "quarterly", "yearly"];

export default function RecurringJournalPanel({
  customerId,
  templates,
  occurrences,
  generationLog,
  chart,
}: {
  customerId: string;
  templates: RecurringTemplate[];
  /** occurrence (manual_journal_entries) ทั้งหมดของลูกค้ารายนี้ที่ผูกกับเทมเพลตในลิสต์นี้ */
  occurrences: RecurringOccurrence[];
  /** ประวัติการ generate ต่อเทมเพลต (key = templateId) */
  generationLog: Record<string, GenerationLogEntry[]>;
  /** ผังบัญชีของ tenant (โหลดจาก DB ครั้งเดียวโดย page.tsx) */
  chart: ChartAccount[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const chartByCode = useMemo(() => buildChartByCode(chart), [chart]);

  // ---- form state (สร้างใหม่/แก้ไข) ----
  const [editingId, setEditingId] = useState<string | null>(null);
  const [docType, setDocType] = useState<ManualDocType>("JV");
  const [frequency, setFrequency] = useState<Frequency>("monthly");
  const [startDate, setStartDate] = useState<string>(todayIso());
  const [endDate, setEndDate] = useState<string>("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<LineRow[]>(() => blankLines());

  const occurrencesByTemplate = useMemo(() => {
    const m = new Map<string, RecurringOccurrence[]>();
    for (const o of occurrences) {
      const arr = m.get(o.templateId) ?? [];
      arr.push(o);
      m.set(o.templateId, arr);
    }
    return m;
  }, [occurrences]);

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

  const previewNextRun = useMemo(() => {
    if (!startDate) return "";
    return nextRunDateAfter(startDate, frequency);
  }, [startDate, frequency]);

  const resetForm = () => {
    setEditingId(null);
    setDocType("JV");
    setFrequency("monthly");
    setStartDate(todayIso());
    setEndDate("");
    setMemo("");
    setLines(blankLines());
  };

  const startEdit = (t: RecurringTemplate) => {
    setMsg(null);
    setEditingId(t.id);
    setDocType(t.docType);
    setFrequency(t.frequency);
    setStartDate(t.startDate);
    setEndDate(t.endDate ?? "");
    setMemo(t.memo ?? "");
    setLines(
      t.lines.length > 0
        ? t.lines.map((l) => ({
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

  function save() {
    setMsg(null);
    startTransition(async () => {
      const res = await saveTemplateAction({
        id: editingId ?? undefined,
        customerId,
        docType,
        memo: memo || null,
        frequency,
        startDate,
        endDate: endDate || null,
        lines: lines.map((l) => ({
          accountCode: l.accountCode,
          accountName: l.accountName || null,
          description: l.description || null,
          debit: parseAmountInput(l.debit),
          credit: parseAmountInput(l.credit),
        })),
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

  function onToggleActive(t: RecurringTemplate) {
    setMsg(null);
    startTransition(async () => {
      const res = await toggleTemplateActiveAction(t.id, customerId, !t.isActive);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  function onDelete(id: string) {
    if (!window.confirm("ลบเทมเพลตนี้? (รายการที่สร้างไปแล้วยังอยู่เหมือนเดิม)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteTemplateAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        if (editingId === id) resetForm();
        router.refresh();
      }
    });
  }

  function onGenerateNow(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await generateNowAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="acc-je">
      {/* ---- ฟอร์ม สร้าง/แก้ไข ---- */}
      <div className="acc-je-form">
        <div className="acc-je-form-head">
          <span className="strong">{editingId ? "แก้ไขเทมเพลต" : "สร้างเทมเพลตใหม่"}</span>
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
            <span>ความถี่</span>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} disabled={pending}>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="acc-field">
            <span>วันที่เริ่มต้น (รอบแรก)</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={pending} />
          </label>
          <label className="acc-field">
            <span>วันที่สิ้นสุด (ไม่บังคับ)</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={pending} />
          </label>
          <label className="acc-field acc-field-wide">
            <span>คำอธิบาย</span>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="เช่น ค่าเช่าสำนักงานรายเดือน"
              maxLength={500}
              disabled={pending}
            />
          </label>
        </div>

        {previewNextRun ? (
          <p className="muted" style={{ fontSize: 13, margin: "4px 0" }}>
            ตัวอย่าง: รอบแรก {formatDateThai(startDate)} · รอบถัดไปจะสร้างประมาณวันที่ {formatDateThai(previewNextRun)}
            {" "}(ค่าจริงคำนวณ ณ ตอน generate — วันที่นี้เป็นตัวอย่างเท่านั้น)
          </p>
        ) : null}

        {/* ---- ตารางบรรทัด (ยอดคงที่ทุกรอบ — 0.6) ---- */}
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
          <button type="button" className="btn" onClick={save} disabled={pending || !balanced}>
            {pending ? "กำลังบันทึก…" : editingId ? "บันทึกการแก้ไข" : "สร้างเทมเพลต"}
          </button>
        </div>
      </div>

      {/* ---- รายการเทมเพลตเดิมของลูกค้ารายนี้ ---- */}
      <div className="acc-je-list">
        <div className="strong" style={{ marginBottom: 8 }}>
          เทมเพลตที่ตั้งไว้แล้ว {templates.length > 0 ? `(${templates.length})` : ""}
        </div>
        {templates.length === 0 ? (
          <p className="empty">ยังไม่มีเทมเพลตรายการบันทึกซ้ำ — สร้างเทมเพลตแรกด้านบน</p>
        ) : (
          <div className="table-wrap">
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>ประเภท</th>
                  <th>ความถี่</th>
                  <th>คำอธิบาย</th>
                  <th className="num">ยอด/รอบ</th>
                  <th>รอบถัดไป</th>
                  <th>สถานะ</th>
                  <th>รายการที่สร้างแล้ว</th>
                  <th>จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => {
                  const occ = occurrencesByTemplate.get(t.id) ?? [];
                  const failedLogs = (generationLog[t.id] ?? []).filter((l) => l.status === "failed");
                  return (
                    <tr key={t.id}>
                      <td className="mono">{t.docType}</td>
                      <td>{FREQUENCY_LABELS[t.frequency]}</td>
                      <td>{t.memo || "—"}</td>
                      <td className="num">{formatMoney(templateTotal(t))}</td>
                      <td>{formatDateThai(t.nextRunDate)}</td>
                      <td>{t.isActive ? "เปิดใช้งาน" : "ปิดใช้งาน"}</td>
                      <td>
                        {occ.length === 0 ? (
                          <span className="muted">ยังไม่มี</span>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {occ.slice(0, 5).map((o) => (
                              <a
                                key={o.id}
                                href={`/chat-audit/accounting/journal-entry?customerId=${customerId}`}
                                className="vat-badge yes"
                                title={`${formatDateThai(o.docDate)} · ${o.status === "confirmed" ? "ยืนยันแล้ว" : "ร่าง"}`}
                              >
                                สร้างจากรายการซ้ำ · {formatDateThai(o.docDate)}
                              </a>
                            ))}
                            {occ.length > 5 ? <span className="muted">และอีก {occ.length - 5} รายการ</span> : null}
                          </div>
                        )}
                        {failedLogs.length > 0 ? (
                          <div className="action-msg err" style={{ marginTop: 4 }}>
                            สร้างไม่สำเร็จล่าสุด ({formatDateThai(failedLogs[0].runDate)}): {failedLogs[0].message || "ไม่ทราบสาเหตุ"}
                          </div>
                        ) : null}
                      </td>
                      <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button type="button" className="btn btn-sm" onClick={() => startEdit(t)} disabled={pending}>
                          แก้ไข
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm green"
                          onClick={() => onGenerateNow(t.id)}
                          disabled={pending || !t.isActive}
                          title={!t.isActive ? "ต้องเปิดใช้งานก่อน" : "สร้างรายการทันที (ถ้าถึงกำหนด)"}
                        >
                          สร้างตอนนี้
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => onToggleActive(t)}
                          disabled={pending}
                        >
                          {t.isActive ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm danger"
                          onClick={() => onDelete(t.id)}
                          disabled={pending}
                        >
                          ลบ
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
