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
  addDays,
  type Frequency,
  type RecurringInvoiceTemplate,
  type RecurringInvoiceOccurrence,
  type GenerationLogEntry,
} from "@/lib/accounting/recurring-invoice";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { parseAmountInput, calcVat, formatMoney, round2 } from "@/lib/accounting/calc";
import AccountCombobox from "../AccountCombobox";

/**
 * RecurringInvoicePanel — ตั้ง/แก้/เปิดปิด/ลบเทมเพลตใบแจ้งหนี้ลูกค้าแบบวนซ้ำ (wishlist ข้อ 4)
 *   - ฟอร์ม: หัวเทมเพลต (คู่ค้า/เลขภาษี/ความถี่/วันเริ่ม/วันสิ้นสุด/ครบกำหนดชำระกี่วัน/หมายเหตุ) + ตาราง
 *     บรรทัดรายการ (บัญชีรายได้ + จำนวน + ราคาต่อหน่วย + VAT) — combobox เลือกบัญชีเดียวกับหน้าอื่น
 *   - รายการเทมเพลตเดิม: แก้ไข / เปิด-ปิดใช้งาน / ลบ (soft-delete) / "สร้างตอนนี้" (บังคับ today ฝั่ง server)
 *   - occurrence ที่สร้างแล้วของแต่ละเทมเพลต: badge "สร้างจากรายการซ้ำ" + ลิงก์ไปหน้าลงบันทึกบัญชี
 *   - ประวัติการสร้าง (log) — โชว์เหตุผลที่ล้มเหลวให้เห็นชัดเจน ไม่เงียบหาย
 *
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope + service-role)
 * ★ ไม่มีปุ่ม "ยืนยัน" ในหน้านี้ — occurrence ที่สร้างเป็นใบแจ้งหนี้ร่าง (draft) เสมอ ต้องไปตรวจสอบ/ยืนยันเอง
 *   ที่หน้าลงบันทึกบัญชี
 */

type LineRow = {
  key: string;
  description: string;
  accountCode: string;
  accountName: string;
  vatType: "vat" | "novat";
  quantity: string;
  unitPrice: string;
};

let keySeq = 0;
function newKey(): string {
  keySeq += 1;
  return `n${keySeq}`;
}

function blankLine(): LineRow {
  return { key: newKey(), description: "", accountCode: "", accountName: "", vatType: "vat", quantity: "1", unitPrice: "" };
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

function templateTotal(t: RecurringInvoiceTemplate): number {
  return t.lines.reduce((s, l) => {
    const amount = l.quantity * l.unitPrice;
    return s + amount + calcVat(amount, l.vatType);
  }, 0);
}

const FREQUENCIES: Frequency[] = ["monthly", "quarterly", "yearly"];

export default function RecurringInvoicePanel({
  customerId,
  templates,
  occurrences,
  generationLog,
  chart,
}: {
  customerId: string;
  templates: RecurringInvoiceTemplate[];
  /** occurrence (bill_entries) ทั้งหมดของลูกค้ารายนี้ที่ผูกกับเทมเพลตในลิสต์นี้ */
  occurrences: RecurringInvoiceOccurrence[];
  /** ประวัติการ generate ต่อเทมเพลต (key = templateId) */
  generationLog: Record<string, GenerationLogEntry[]>;
  /** ผังบัญชีของ tenant (โหลดจาก DB ครั้งเดียวโดย page.tsx) */
  chart: ChartAccount[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // ---- form state (สร้างใหม่/แก้ไข) ----
  const [editingId, setEditingId] = useState<string | null>(null);
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyTaxId, setCounterpartyTaxId] = useState("");
  const [notes, setNotes] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("monthly");
  const [startDate, setStartDate] = useState<string>(todayIso());
  const [endDate, setEndDate] = useState<string>("");
  const [dueDays, setDueDays] = useState<string>("30");
  const [lines, setLines] = useState<LineRow[]>(() => [blankLine()]);

  const occurrencesByTemplate = useMemo(() => {
    const m = new Map<string, RecurringInvoiceOccurrence[]>();
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
  const addLineRow = () => setLines((prev) => [...prev, blankLine()]);
  const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l.key !== key));

  const lineTotals = useMemo(() => {
    return lines.map((l) => {
      const amount = round2(parseAmountInput(l.quantity) * parseAmountInput(l.unitPrice));
      return { amount, vat: calcVat(amount, l.vatType) };
    });
  }, [lines]);

  const grandTotal = useMemo(
    () => lineTotals.reduce((s, x) => s + x.amount + x.vat, 0),
    [lineTotals]
  );

  const previewNextRun = useMemo(() => {
    if (!startDate) return "";
    return nextRunDateAfter(startDate, frequency);
  }, [startDate, frequency]);

  const previewDueDate = useMemo(() => {
    if (!startDate) return "";
    const d = parseAmountInput(dueDays);
    return addDays(startDate, Math.round(d));
  }, [startDate, dueDays]);

  const resetForm = () => {
    setEditingId(null);
    setCounterpartyName("");
    setCounterpartyTaxId("");
    setNotes("");
    setFrequency("monthly");
    setStartDate(todayIso());
    setEndDate("");
    setDueDays("30");
    setLines([blankLine()]);
  };

  const startEdit = (t: RecurringInvoiceTemplate) => {
    setMsg(null);
    setEditingId(t.id);
    setCounterpartyName(t.counterpartyName);
    setCounterpartyTaxId(t.counterpartyTaxId ?? "");
    setNotes(t.notes ?? "");
    setFrequency(t.frequency);
    setStartDate(t.startDate);
    setEndDate(t.endDate ?? "");
    setDueDays(String(t.dueDays));
    setLines(
      t.lines.length > 0
        ? t.lines.map((l) => ({
            key: newKey(),
            description: l.description ?? "",
            accountCode: l.accountCode,
            accountName: l.accountName ?? "",
            vatType: l.vatType,
            quantity: String(l.quantity),
            unitPrice: String(l.unitPrice),
          }))
        : [blankLine()]
    );
  };

  function save() {
    setMsg(null);
    startTransition(async () => {
      const res = await saveTemplateAction({
        id: editingId ?? undefined,
        customerId,
        counterpartyName,
        counterpartyTaxId: counterpartyTaxId || null,
        notes: notes || null,
        frequency,
        startDate,
        endDate: endDate || null,
        dueDays: parseAmountInput(dueDays),
        lines: lines.map((l) => ({
          description: l.description || null,
          accountCode: l.accountCode,
          accountName: l.accountName || null,
          vatType: l.vatType,
          quantity: parseAmountInput(l.quantity),
          unitPrice: parseAmountInput(l.unitPrice),
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

  function onToggleActive(t: RecurringInvoiceTemplate) {
    setMsg(null);
    startTransition(async () => {
      const res = await toggleTemplateActiveAction(t.id, customerId, !t.isActive);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  function onDelete(id: string) {
    if (!window.confirm("ลบเทมเพลตนี้? (ใบแจ้งหนี้ที่สร้างไปแล้วยังอยู่เหมือนเดิม)")) return;
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
          <label className="acc-field acc-field-wide">
            <span>ชื่อคู่ค้า (ผู้รับใบแจ้งหนี้)</span>
            <input
              type="text"
              value={counterpartyName}
              onChange={(e) => setCounterpartyName(e.target.value)}
              placeholder="เช่น บริษัท ABC จำกัด"
              maxLength={200}
              disabled={pending}
            />
          </label>
          <label className="acc-field">
            <span>เลขประจำตัวผู้เสียภาษี (ไม่บังคับ)</span>
            <input
              type="text"
              value={counterpartyTaxId}
              onChange={(e) => setCounterpartyTaxId(e.target.value)}
              maxLength={20}
              disabled={pending}
            />
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
          <label className="acc-field">
            <span>ครบกำหนดชำระ (วันหลังวันที่ออกบิล)</span>
            <input
              type="text"
              inputMode="numeric"
              value={dueDays}
              onChange={(e) => setDueDays(e.target.value)}
              disabled={pending}
            />
          </label>
          <label className="acc-field acc-field-wide">
            <span>หมายเหตุ (ไม่บังคับ)</span>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="เช่น ค่าบริการดูแลระบบรายเดือน"
              maxLength={500}
              disabled={pending}
            />
          </label>
        </div>

        {previewNextRun ? (
          <p className="muted" style={{ fontSize: 13, margin: "4px 0" }}>
            ตัวอย่าง: รอบแรก {formatDateThai(startDate)} · ครบกำหนดชำระประมาณ {formatDateThai(previewDueDate)} · รอบถัดไปจะสร้างประมาณวันที่ {formatDateThai(previewNextRun)}
            {" "}(ค่าจริงคำนวณ ณ ตอน generate — วันที่นี้เป็นตัวอย่างเท่านั้น)
          </p>
        ) : null}

        {/* ---- ตารางบรรทัดรายการ (ยอดต่อบรรทัดคงที่ทุกรอบ) ---- */}
        <div className="acc-je-lines">
          <div className="acc-je-lines-head">
            <span>รายละเอียด</span>
            <span>บัญชีรายได้</span>
            <span className="num">จำนวน</span>
            <span className="num">ราคา/หน่วย</span>
            <span>VAT</span>
            <span className="num">รวม</span>
            <span />
          </div>
          {lines.map((l, idx) => (
            <div className="acc-je-line" key={l.key}>
              <input
                type="text"
                value={l.description}
                onChange={(e) => patchLine(l.key, { description: e.target.value })}
                placeholder="เช่น ค่าบริการเดือน ม.ค."
                maxLength={200}
                disabled={pending}
                aria-label="รายละเอียด"
              />
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
                className="num"
                inputMode="decimal"
                value={l.quantity}
                onChange={(e) => patchLine(l.key, { quantity: e.target.value })}
                placeholder="1"
                disabled={pending}
                aria-label="จำนวน"
              />
              <input
                className="num"
                inputMode="decimal"
                value={l.unitPrice}
                onChange={(e) => patchLine(l.key, { unitPrice: e.target.value })}
                placeholder="0.00"
                disabled={pending}
                aria-label="ราคาต่อหน่วย"
              />
              <select
                value={l.vatType}
                onChange={(e) => patchLine(l.key, { vatType: e.target.value === "novat" ? "novat" : "vat" })}
                disabled={pending}
                aria-label="ประเภท VAT"
              >
                <option value="vat">VAT 7%</option>
                <option value="novat">ไม่มี VAT</option>
              </select>
              <span className="num">{formatMoney((lineTotals[idx]?.amount ?? 0) + (lineTotals[idx]?.vat ?? 0))}</span>
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
          <button type="button" className="acc-add-line" onClick={addLineRow} disabled={pending}>
            + เพิ่มบรรทัด
          </button>

          <div className="acc-je-line acc-je-total">
            <span className="strong">รวมทั้งใบ</span>
            <span />
            <span />
            <span />
            <span />
            <span className="num strong">{formatMoney(grandTotal)}</span>
            <span />
          </div>
        </div>

        {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}

        <div className="acc-modal-actions">
          <button type="button" className="btn" onClick={save} disabled={pending || !counterpartyName.trim()}>
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
          <p className="empty">ยังไม่มีเทมเพลตใบแจ้งหนี้แบบวนซ้ำ — สร้างเทมเพลตแรกด้านบน</p>
        ) : (
          <div className="table-wrap">
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>คู่ค้า</th>
                  <th>ความถี่</th>
                  <th className="num">ยอด/รอบ</th>
                  <th>รอบถัดไป</th>
                  <th>สถานะ</th>
                  <th>ใบแจ้งหนี้ที่สร้างแล้ว</th>
                  <th>จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => {
                  const occ = occurrencesByTemplate.get(t.id) ?? [];
                  const failedLogs = (generationLog[t.id] ?? []).filter((l) => l.status === "failed");
                  return (
                    <tr key={t.id}>
                      <td>{t.counterpartyName}</td>
                      <td>{FREQUENCY_LABELS[t.frequency]}</td>
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
                                href={`/chat-audit/accounting?customerId=${customerId}&type=sale`}
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
                          title={!t.isActive ? "ต้องเปิดใช้งานก่อน" : "สร้างใบแจ้งหนี้ทันที (ถ้าถึงกำหนด)"}
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

