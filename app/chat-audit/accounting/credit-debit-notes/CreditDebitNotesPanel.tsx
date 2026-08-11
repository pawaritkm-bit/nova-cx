"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upsertNoteAction, confirmNoteAction, voidNoteAction } from "./actions";
import {
  NOTE_DOC_TYPE_LABELS,
  noteNetTotal,
  type NoteDocType,
  type CreditDebitNote,
} from "@/lib/accounting/credit-debit-notes";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";
import { round2 } from "@/lib/accounting/queries";
import AccountCombobox from "../AccountCombobox";

/**
 * CreditDebitNotesPanel — สร้าง/แก้/ยืนยัน/ยกเลิกใบลดหนี้/เพิ่มหนี้ ต่อบิลเชื่อของลูกค้า 1 ราย (เฟส 3 ส่วน J)
 *   - list บิลเชื่อของลูกค้ารายนั้น (docNo/docDate/คู่ค้า/ยอดเต็ม/ยอดค้างชำระ)
 *   - แต่ละบิล: ปุ่ม "ใบลดหนี้/เพิ่มหนี้" → ฟอร์ม (ประเภท/วันที่/เลขที่/เหตุผล + บรรทัด: บัญชี/รายละเอียด/ยอด/VAT)
 *     + ประวัติ CN/DN เดิมของบิลนั้น (แก้ไข/ยืนยันได้เฉพาะ draft, ยกเลิกได้ทุกสถานะ)
 *
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope + service-role,
 *   re-validate ที่ server เสมอ — ไม่เชื่อ client)
 */

export type NoteBillRow = {
  entryId: string;
  entryType: "sale" | "purchase";
  docNo: string | null;
  docDate: string | null;
  counterpartyName: string | null;
  netTotal: number;
  outstanding: number;
  notes: CreditDebitNote[];
  /** เฟส 10 ส่วน AA — สกุลเงินของบิลต้นทาง (null = บิล THB ปกติ — ไม่โชว์ช่อง fx เลย) */
  currency: string | null;
  /** เฟส 10 ส่วน AA — อัตราแลกเปลี่ยนของบิลต้นทาง (read-only, อ้างอิงเท่านั้น — ใช้อัตรานี้เสมอ ไม่ใช่วันออก CN/DN) */
  fxRate: number | null;
};

type LineRow = {
  key: string;
  accountCode: string;
  accountName: string;
  description: string;
  /** เฟส 10 ส่วน AA — ยอดต้นฉบับสกุลต่างประเทศ (มีความหมายเฉพาะบิลต้นทาง FX) */
  fxAmount: string;
  amount: string;
  vatAmount: string;
};

let keySeq = 0;
function newKey(): string {
  keySeq += 1;
  return `n${keySeq}`;
}

function blankLine(): LineRow {
  return { key: newKey(), accountCode: "", accountName: "", description: "", fxAmount: "", amount: "", vatAmount: "" };
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO → ไทย วว/ดด/ปปปป (พ.ศ.) — คืน "—" ถ้าไม่มีค่า */
function formatDateThai(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso;
}

type FormState = {
  editingId: string | null;
  docType: NoteDocType;
  docDate: string;
  docNo: string;
  reason: string;
  lines: LineRow[];
};

function blankForm(): FormState {
  return { editingId: null, docType: "credit_note", docDate: todayIso(), docNo: "", reason: "", lines: [blankLine()] };
}

export default function CreditDebitNotesPanel({
  customerId,
  bills,
  chart,
  initialOpenEntryId,
}: {
  customerId: string;
  bills: NoteBillRow[];
  /** ผังบัญชีของ tenant (โหลดจาก DB ครั้งเดียวโดย page.tsx) */
  chart: ChartAccount[];
  /** entryId จาก ?entryId= (deep link จาก RowActions.tsx ของหน้าลงบันทึกบัญชี) — เปิดแถวนี้ให้อัตโนมัติ */
  initialOpenEntryId?: string;
}) {
  void customerId; // ใช้แค่ scope ที่ page.tsx โหลดมา — entryId ผูกลูกค้าอยู่แล้ว
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(initialOpenEntryId ?? null);
  const [forms, setForms] = useState<Record<string, FormState>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const formOf = (entryId: string): FormState => forms[entryId] ?? blankForm();
  const patchForm = (entryId: string, patch: Partial<FormState>) => {
    setForms((prev) => ({ ...prev, [entryId]: { ...(prev[entryId] ?? blankForm()), ...patch } }));
  };
  const patchLine = (entryId: string, key: string, patch: Partial<LineRow>) => {
    setForms((prev) => {
      const cur = prev[entryId] ?? blankForm();
      return { ...prev, [entryId]: { ...cur, lines: cur.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) } };
    });
  };
  const addLine = (entryId: string) => {
    setForms((prev) => {
      const cur = prev[entryId] ?? blankForm();
      return { ...prev, [entryId]: { ...cur, lines: [...cur.lines, blankLine()] } };
    });
  };
  const removeLine = (entryId: string, key: string) => {
    setForms((prev) => {
      const cur = prev[entryId] ?? blankForm();
      return { ...prev, [entryId]: { ...cur, lines: cur.lines.filter((l) => l.key !== key) } };
    });
  };

  function toggleOpen(entryId: string) {
    setMsg(null);
    if (openId === entryId) {
      setOpenId(null);
      return;
    }
    setOpenId(entryId);
    if (!forms[entryId]) patchForm(entryId, blankForm());
  }

  function startEdit(bill: NoteBillRow, note: CreditDebitNote) {
    if (note.status !== "draft") {
      setMsg({ ok: false, text: "รายการนี้ยืนยันแล้ว — ยกเลิกแล้วออกใบใหม่แทน" });
      return;
    }
    setMsg(null);
    setOpenId(bill.entryId);
    patchForm(bill.entryId, {
      editingId: note.id,
      docType: note.docType,
      docDate: note.docDate,
      docNo: note.docNo ?? "",
      reason: note.reason,
      lines:
        note.lines.length > 0
          ? note.lines.map((l) => ({
              key: newKey(),
              accountCode: l.accountCode,
              accountName: l.accountName ?? "",
              description: l.description ?? "",
              fxAmount: l.fxAmount ? String(l.fxAmount) : "",
              amount: l.amount ? String(l.amount) : "",
              vatAmount: l.vatAmount ? String(l.vatAmount) : "",
            }))
          : [blankLine()],
    });
  }

  function submit(bill: NoteBillRow) {
    const f = formOf(bill.entryId);
    setMsg(null);
    startTransition(async () => {
      const res = await upsertNoteAction({
        id: f.editingId ?? undefined,
        entryId: bill.entryId,
        docType: f.docType,
        docDate: f.docDate,
        docNo: f.docNo || null,
        reason: f.reason,
        lines: f.lines.map((l) => ({
          description: l.description || null,
          accountCode: l.accountCode,
          accountName: l.accountName || null,
          // เฟส 10 ส่วน AA — ส่งเฉพาะบิลต้นทาง FX (currency ตั้งไว้) เท่านั้น
          fxAmount: bill.currency ? parseAmountInput(l.fxAmount) : undefined,
          amount: parseAmountInput(l.amount),
          vatAmount: parseAmountInput(l.vatAmount),
        })),
      });
      setMsg({ ok: res.ok, text: res.ok ? "บันทึกแล้ว" : res.message });
      if (res.ok) {
        setForms((prev) => {
          const next = { ...prev };
          delete next[bill.entryId];
          return next;
        });
        router.refresh();
      }
    });
  }

  function onConfirm(id: string) {
    if (!window.confirm("ยืนยันเอกสารนี้? หลังยืนยันแก้ไขไม่ได้อีก (ผิดพลาดต้องยกเลิกแล้วออกใบใหม่)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await confirmNoteAction(id);
      setMsg({ ok: res.ok, text: res.ok ? "ยืนยันแล้ว" : res.message });
      if (res.ok) router.refresh();
    });
  }

  function onVoid(id: string) {
    if (!window.confirm("ยกเลิกเอกสารนี้? (ถ้ายืนยันแล้ว ยอดค้างชำระ/รายงานจะกลับมาเหมือนไม่เคยมีใบนี้)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await voidNoteAction(id);
      setMsg({ ok: res.ok, text: res.ok ? "ยกเลิกรายการแล้ว" : res.message });
      if (res.ok) router.refresh();
    });
  }

  if (bills.length === 0) {
    return <p className="empty">ไม่มีบิลเชื่อที่ยืนยันแล้วของลูกค้ารายนี้ (ออกได้เฉพาะบิลเชื่อ — 0.3)</p>;
  }

  return (
    <div className="acc-je">
      {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}

      <div className="table-wrap">
        <table className="dlv-table acc-table">
          <thead>
            <tr>
              <th>ประเภท</th>
              <th>เลขที่</th>
              <th>คู่ค้า</th>
              <th className="num">ยอดเต็ม</th>
              <th className="num">ยอดค้างชำระ</th>
              <th>ใบลดหนี้/เพิ่มหนี้</th>
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((bill) => {
              const f = formOf(bill.entryId);
              return (
                <Fragment key={bill.entryId}>
                  <tr>
                    <td>{bill.entryType === "sale" ? "ลูกหนี้ (ขาย)" : "เจ้าหนี้ (ซื้อ)"}</td>
                    <td>{bill.docNo || "—"}</td>
                    <td>{bill.counterpartyName || "—"}</td>
                    <td className="num">{formatMoney(bill.netTotal)}</td>
                    <td className="num strong">{formatMoney(bill.outstanding)}</td>
                    <td>{bill.notes.length > 0 ? bill.notes.length : "—"}</td>
                    <td>
                      <button type="button" className="btn btn-sm" onClick={() => toggleOpen(bill.entryId)} disabled={pending}>
                        {openId === bill.entryId ? "ปิด" : "+ สร้าง/ดู"}
                      </button>
                    </td>
                  </tr>
                  {openId === bill.entryId ? (
                    <tr>
                      <td colSpan={7}>
                        <div className="acc-je-form" style={{ marginTop: 0 }}>
                          <div className="acc-je-form-head">
                            <span className="strong">{f.editingId ? "แก้ไขรายการ" : "สร้างรายการใหม่"}</span>
                            {f.editingId ? (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => patchForm(bill.entryId, blankForm())}
                                disabled={pending}
                              >
                                + สร้างใหม่แทน
                              </button>
                            ) : null}
                          </div>

                          <div className="acc-field-grid">
                            <label className="acc-field">
                              <span>ประเภทเอกสาร</span>
                              <select
                                value={f.docType}
                                onChange={(e) => patchForm(bill.entryId, { docType: e.target.value as NoteDocType })}
                                disabled={pending}
                              >
                                {(Object.keys(NOTE_DOC_TYPE_LABELS) as NoteDocType[]).map((t) => (
                                  <option key={t} value={t}>
                                    {NOTE_DOC_TYPE_LABELS[t]}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="acc-field">
                              <span>วันที่เอกสาร</span>
                              <input
                                type="date"
                                value={f.docDate}
                                onChange={(e) => patchForm(bill.entryId, { docDate: e.target.value })}
                                disabled={pending}
                              />
                            </label>
                            <label className="acc-field">
                              <span>เลขที่เอกสาร</span>
                              <input
                                type="text"
                                value={f.docNo}
                                onChange={(e) => patchForm(bill.entryId, { docNo: e.target.value })}
                                placeholder="เช่น CN-001"
                                maxLength={50}
                                disabled={pending}
                              />
                            </label>
                            <label className="acc-field acc-field-wide">
                              <span>เหตุผล (บังคับ)</span>
                              <input
                                type="text"
                                value={f.reason}
                                onChange={(e) => patchForm(bill.entryId, { reason: e.target.value })}
                                placeholder="เช่น สินค้าชำรุด คืนสินค้าบางส่วน"
                                maxLength={500}
                                disabled={pending}
                              />
                            </label>
                          </div>

                          {bill.currency ? (
                            <div className="acc-field acc-field-wide acc-contra-hint">
                              บิลต้นทางเป็นสกุล {bill.currency} (อัตราแลกเปลี่ยนตอนออกบิล {bill.fxRate ?? "—"}) —
                              กรอก &quot;จำนวนเงินตราต่างประเทศ&quot; ต่อบรรทัด ระบบจะคำนวณยอด (บาท) ให้ด้วยอัตรานี้เสมอ
                              (ไม่ใช่อัตราวันที่ออกใบลดหนี้/เพิ่มหนี้)
                            </div>
                          ) : null}
                          <div className="acc-je-lines">
                            <div className="acc-je-lines-head">
                              <span>บัญชี</span>
                              <span>รายละเอียด</span>
                              <span className="num">{bill.currency ? `จำนวนเงินตรา (${bill.currency})` : "ยอด"}</span>
                              <span className="num">VAT</span>
                              <span />
                            </div>
                            {f.lines.map((l) => (
                              <div className="acc-je-line" key={l.key}>
                                <AccountCombobox
                                  accountCode={l.accountCode}
                                  accountName={l.accountName}
                                  chart={chart}
                                  readOnly={false}
                                  onSelect={(code, name) => patchLine(bill.entryId, l.key, { accountCode: code, accountName: name })}
                                  onNameChange={(name) => patchLine(bill.entryId, l.key, { accountName: name })}
                                  onClear={() => patchLine(bill.entryId, l.key, { accountCode: "", accountName: "" })}
                                />
                                <input
                                  type="text"
                                  value={l.description}
                                  onChange={(e) => patchLine(bill.entryId, l.key, { description: e.target.value })}
                                  placeholder="รายละเอียด (ไม่บังคับ)"
                                  maxLength={200}
                                  disabled={pending}
                                  aria-label="รายละเอียด"
                                />
                                {bill.currency ? (
                                  <input
                                    className="num"
                                    inputMode="decimal"
                                    value={l.fxAmount}
                                    onChange={(e) => {
                                      const fx = e.target.value;
                                      const derived = bill.fxRate ? round2(parseAmountInput(fx) * bill.fxRate) : 0;
                                      patchLine(bill.entryId, l.key, { fxAmount: fx, amount: derived ? String(derived) : "" });
                                    }}
                                    placeholder="0.00"
                                    disabled={pending}
                                    aria-label={`จำนวนเงินตรา (${bill.currency})`}
                                  />
                                ) : (
                                  <input
                                    className="num"
                                    inputMode="decimal"
                                    value={l.amount}
                                    onChange={(e) => patchLine(bill.entryId, l.key, { amount: e.target.value })}
                                    placeholder="0.00"
                                    disabled={pending}
                                    aria-label="ยอด"
                                  />
                                )}
                                <input
                                  className="num"
                                  inputMode="decimal"
                                  value={l.vatAmount}
                                  onChange={(e) => patchLine(bill.entryId, l.key, { vatAmount: e.target.value })}
                                  placeholder="0.00"
                                  disabled={pending}
                                  aria-label="VAT"
                                />
                                <button
                                  type="button"
                                  className="acc-line-del"
                                  onClick={() => removeLine(bill.entryId, l.key)}
                                  disabled={pending || f.lines.length <= 1}
                                  aria-label="ลบบรรทัด"
                                  title="ลบบรรทัด"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                            <button type="button" className="acc-add-line" onClick={() => addLine(bill.entryId)} disabled={pending}>
                              + เพิ่มบรรทัด
                            </button>
                          </div>

                          <div className="acc-modal-actions">
                            <button type="button" className="btn green" onClick={() => submit(bill)} disabled={pending}>
                              {pending ? "กำลังบันทึก…" : f.editingId ? "บันทึกการแก้ไข" : "บันทึกร่าง"}
                            </button>
                          </div>

                          {bill.notes.length > 0 ? (
                            <div style={{ marginTop: 16 }}>
                              <div className="strong" style={{ marginBottom: 6 }}>
                                ใบลดหนี้/เพิ่มหนี้ของบิลนี้ ({bill.notes.length})
                              </div>
                              <div className="table-wrap">
                                <table className="dlv-table acc-table">
                                  <thead>
                                    <tr>
                                      <th>ประเภท</th>
                                      <th>วันที่</th>
                                      <th>เลขที่</th>
                                      <th>เหตุผล</th>
                                      <th className="num">ยอด</th>
                                      <th>สถานะ</th>
                                      <th>จัดการ</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {bill.notes.map((note) => (
                                      <tr key={note.id}>
                                        <td>{NOTE_DOC_TYPE_LABELS[note.docType]}</td>
                                        <td>{formatDateThai(note.docDate)}</td>
                                        <td>{note.docNo || "—"}</td>
                                        <td>{note.reason || "—"}</td>
                                        <td className="num">{formatMoney(noteNetTotal(note))}</td>
                                        <td>{note.status === "confirmed" ? "ยืนยันแล้ว" : "ร่าง"}</td>
                                        <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                          {note.status === "draft" ? (
                                            <>
                                              <button
                                                type="button"
                                                className="btn btn-sm"
                                                onClick={() => startEdit(bill, note)}
                                                disabled={pending}
                                              >
                                                แก้ไข
                                              </button>
                                              <button
                                                type="button"
                                                className="btn btn-sm green"
                                                onClick={() => onConfirm(note.id)}
                                                disabled={pending}
                                              >
                                                ยืนยัน
                                              </button>
                                            </>
                                          ) : null}
                                          <button
                                            type="button"
                                            className="btn btn-sm danger"
                                            onClick={() => onVoid(note.id)}
                                            disabled={pending}
                                          >
                                            ยกเลิก
                                          </button>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
