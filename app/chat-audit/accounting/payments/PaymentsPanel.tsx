"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  recordBillPaymentAction,
  voidBillPaymentAction,
  suggestFxGainLossNoteAction,
  setInstallmentPlanAction,
  clearInstallmentPlanAction,
} from "./actions";
import { AGING_BUCKET_LABELS, type AgingBucketKey } from "@/lib/accounting/aging";
import type { BillPayment, BillPaymentMethod } from "@/lib/accounting/bill-payments";
import { computeInstallmentStatuses, type BillInstallment, type InstallmentStatus } from "@/lib/accounting/bill-installments";
import type { CustomerBankAccount } from "@/lib/accounting/bank-accounts";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";

/**
 * PaymentsPanel — บันทึก/ยกเลิกรับ-จ่ายเงินแยกจากบิล ของลูกค้า 1 ราย (เฟส 2 ส่วน F, docs/06 หมวด F2)
 *   - list บิลเชื่อที่ยังค้างชำระ (docNo/docDate/dueDate/กลุ่มอายุหนี้/ยอดเต็ม/ยอดค้างชำระ)
 *   - แต่ละบิล: ปุ่ม "บันทึกรับ/จ่ายเงิน" → ฟอร์ม (วันที่/จำนวนเงิน/วิธี/บัญชีธนาคารถ้าโอน/หมายเหตุ)
 *     + ประวัติการรับ/จ่ายเงินเดิม (ปุ่ม "ยกเลิก" ต่อรายการ)
 *
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope + service-role,
 *   re-validate ยอดชำระเกินยอดค้างที่ server เสมอ — ไม่เชื่อ client)
 */

export type PaymentBillRow = {
  entryId: string;
  entryType: "sale" | "purchase";
  docNo: string | null;
  docDate: string | null;
  dueDate: string | null;
  counterpartyName: string | null;
  netTotal: number;
  outstanding: number;
  bucket: AgingBucketKey;
  payments: BillPayment[];
  /** wishlist ข้อ 7 — แผนงวดผ่อนชำระ (array ว่าง = ยังไม่มีแผน) */
  installments: BillInstallment[];
  /** wishlist ข้อ 7 — มี CN/DN ที่ confirmed แล้วปรับยอดบิลนี้อยู่ไหม (เตือนใน UI เท่านั้น — ดูคอมเมนต์ page.tsx) */
  hasNoteAdjustment: boolean;
  /** เฟส 10 ส่วน AA — สกุลเงินของบิลต้นทาง (null = บิล THB ปกติ — ไม่โชว์ช่อง fx/ปุ่มแนะนำ FX เลย) */
  currency: string | null;
  /** เฟส 10 ส่วน AA — อัตราแลกเปลี่ยนตอนออกบิล (ใช้แสดงอ้างอิงเท่านั้น — ยอด THB คำนวณที่ server เสมอ) */
  fxRate: number | null;
};

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

const METHOD_LABELS: Record<BillPaymentMethod, string> = {
  cash: "เงินสด",
  cheque: "เช็ค",
  transfer: "เงินโอน",
};

const INSTALLMENT_STATUS_LABELS: Record<InstallmentStatus, string> = {
  paid: "ชำระแล้ว",
  overdue: "เกินกำหนด",
  upcoming: "ยังไม่ครบกำหนด",
};
const INSTALLMENT_STATUS_CLASS: Record<InstallmentStatus, string> = {
  paid: "st-confirmed",
  overdue: "st-warn",
  upcoming: "st-draft",
};

type InstallmentFormRow = { dueDate: string; amount: string };

/** แถวเริ่มต้นของฟอร์มแผนผ่อนชำระ — มีแผนอยู่แล้ว = prefill จากแผนเดิม, ไม่มี = 2 แถวเปล่า */
function defaultInstallmentRows(bill: PaymentBillRow): InstallmentFormRow[] {
  if (bill.installments.length > 0) {
    return bill.installments.map((i) => ({ dueDate: i.dueDate, amount: String(i.plannedAmount) }));
  }
  return [{ dueDate: "", amount: "" }, { dueDate: "", amount: "" }];
}

type FormState = {
  payDate: string;
  amount: string;
  method: BillPaymentMethod;
  bankAccountId: string;
  notes: string;
  /** เฟส 10 ส่วน AA — จำนวนเงินตราต่างประเทศงวดนี้ (มีความหมายเฉพาะบิลที่ currency ตั้งไว้) */
  fxAmount: string;
  /** เฟส 10 ส่วน AA — อัตราแลกเปลี่ยนวันชำระของงวดนี้ (คนละอัตรากับ fxRate ตอนออกบิล) */
  fxRate: string;
};

function blankForm(outstanding: number): FormState {
  return {
    payDate: todayIso(),
    amount: outstanding > 0 ? String(outstanding) : "",
    method: "cash",
    bankAccountId: "",
    notes: "",
    fxAmount: "",
    fxRate: "",
  };
}

export default function PaymentsPanel({
  customerId,
  bills,
  bankAccounts,
}: {
  customerId: string;
  bills: PaymentBillRow[];
  /** บัญชีเงินฝากของลูกค้ารายนี้ — เลือกได้เมื่อวิธี = โอน (ไม่บังคับ ถ้าไม่มีก็บันทึกได้โดยไม่ระบุบัญชี) */
  bankAccounts: CustomerBankAccount[];
}) {
  void customerId; // ใช้แค่ scope ที่ page.tsx โหลดมา — ไม่ต้องใช้ในฟอร์ม (entryId ผูกลูกค้าอยู่แล้ว)
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, FormState>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // wishlist ข้อ 7 — ฟอร์มแก้ไขแผนผ่อนชำระ (แยก state จากฟอร์มบันทึกรับ/จ่ายเงินด้านบน)
  const [installmentForms, setInstallmentForms] = useState<Record<string, InstallmentFormRow[]>>({});

  const formOf = (bill: PaymentBillRow): FormState => forms[bill.entryId] ?? blankForm(bill.outstanding);
  const patchForm = (entryId: string, patch: Partial<FormState>) => {
    setForms((prev) => ({ ...prev, [entryId]: { ...(prev[entryId] ?? blankForm(0)), ...patch } }));
  };

  function openInstallmentEdit(bill: PaymentBillRow) {
    setMsg(null);
    setInstallmentForms((prev) => ({ ...prev, [bill.entryId]: prev[bill.entryId] ?? defaultInstallmentRows(bill) }));
  }
  function closeInstallmentEdit(entryId: string) {
    setInstallmentForms((prev) => {
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
  }
  function addInstallmentRow(entryId: string) {
    setInstallmentForms((prev) => ({ ...prev, [entryId]: [...(prev[entryId] ?? []), { dueDate: "", amount: "" }] }));
  }
  function removeInstallmentRow(entryId: string, idx: number) {
    setInstallmentForms((prev) => ({ ...prev, [entryId]: (prev[entryId] ?? []).filter((_, i) => i !== idx) }));
  }
  function patchInstallmentRow(entryId: string, idx: number, patch: Partial<InstallmentFormRow>) {
    setInstallmentForms((prev) => ({
      ...prev,
      [entryId]: (prev[entryId] ?? []).map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }));
  }
  function installmentRowsTotal(entryId: string): number {
    return (installmentForms[entryId] ?? []).reduce((s, r) => s + parseAmountInput(r.amount), 0);
  }

  function submitInstallmentPlan(bill: PaymentBillRow) {
    const rows = installmentForms[bill.entryId] ?? [];
    setMsg(null);
    startTransition(async () => {
      const res = await setInstallmentPlanAction(
        bill.entryId,
        rows.map((r) => ({ dueDate: r.dueDate, amount: parseAmountInput(r.amount) }))
      );
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        closeInstallmentEdit(bill.entryId);
        router.refresh();
      }
    });
  }

  function onClearInstallmentPlan(entryId: string) {
    if (!window.confirm("ลบแผนผ่อนชำระนี้? (ไม่กระทบยอดค้างชำระ/การรับ-จ่ายเงินจริงที่บันทึกไว้แล้ว)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await clearInstallmentPlanAction(entryId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  function toggleOpen(bill: PaymentBillRow) {
    setMsg(null);
    if (openId === bill.entryId) {
      setOpenId(null);
      return;
    }
    setOpenId(bill.entryId);
    if (!forms[bill.entryId]) patchForm(bill.entryId, blankForm(bill.outstanding));
  }

  function submit(bill: PaymentBillRow) {
    const f = formOf(bill);
    setMsg(null);
    startTransition(async () => {
      const res = await recordBillPaymentAction({
        entryId: bill.entryId,
        payDate: f.payDate,
        amount: parseAmountInput(f.amount),
        method: f.method,
        bankAccountId: f.method === "transfer" && f.bankAccountId ? f.bankAccountId : null,
        notes: f.notes || null,
        // เฟส 10 ส่วน AA — ส่งเฉพาะบิล FX (currency ตั้งไว้) เท่านั้น
        fxAmount: bill.currency ? parseAmountInput(f.fxAmount) : undefined,
        fxRate: bill.currency ? parseAmountInput(f.fxRate) : undefined,
      });
      setMsg({ ok: res.ok, text: res.ok ? "บันทึกรับ/จ่ายเงินแล้ว" : res.message });
      if (res.ok) {
        setOpenId(null);
        setForms((prev) => {
          const next = { ...prev };
          delete next[bill.entryId];
          return next;
        });
        router.refresh();
      }
    });
  }

  function onVoid(paymentId: string) {
    if (!window.confirm("ยกเลิกรายการรับ/จ่ายเงินนี้? (ยอดค้างชำระของบิลจะกลับมาเดิม)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await voidBillPaymentAction(paymentId);
      setMsg({ ok: res.ok, text: res.ok ? "ยกเลิกรายการแล้ว" : res.message });
      if (res.ok) router.refresh();
    });
  }

  /** เฟส 10 ส่วน AA (0.5) — "แนะนำ" กำไร/ขาดทุนจากอัตราแลกเปลี่ยน (สร้าง JV draft — ไม่ auto-confirm) */
  function onSuggestFx(paymentId: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await suggestFxGainLossNoteAction(paymentId);
      setMsg({
        ok: res.ok,
        text: res.ok ? "สร้างรายการแนะนำ (ร่าง) แล้ว — ไปตรวจ/ยืนยันที่หน้าลงบัญชีเอง" : res.message,
      });
      if (res.ok) router.refresh();
    });
  }

  if (bills.length === 0) {
    return <p className="empty">ไม่มีบิลเชื่อที่ค้างชำระของลูกค้ารายนี้ (บิลเงินสด/เช็ค/โอน จ่ายเงินเสร็จตั้งแต่ยืนยันบิลแล้ว)</p>;
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
              <th>วันครบกำหนด</th>
              <th>อายุหนี้</th>
              <th className="num">ยอดเต็ม</th>
              <th className="num">ยอดค้างชำระ</th>
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((bill) => (
              <Fragment key={bill.entryId}>
                <tr>
                  <td>{bill.entryType === "sale" ? "ลูกหนี้ (ขาย)" : "เจ้าหนี้ (ซื้อ)"}</td>
                  <td>{bill.docNo || "—"}</td>
                  <td>{bill.counterpartyName || "—"}</td>
                  <td>{formatDateThai(bill.dueDate)}</td>
                  <td>{AGING_BUCKET_LABELS[bill.bucket]}</td>
                  <td className="num">{formatMoney(bill.netTotal)}</td>
                  <td className="num strong">{formatMoney(bill.outstanding)}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => toggleOpen(bill)} disabled={pending}>
                      {openId === bill.entryId ? "ปิด" : bill.entryType === "sale" ? "บันทึกรับเงิน" : "บันทึกจ่ายเงิน"}
                    </button>
                  </td>
                </tr>
                {openId === bill.entryId ? (
                  <tr>
                    <td colSpan={8}>
                      <div className="acc-je-form" style={{ marginTop: 0 }}>
                        <div className="acc-field-grid">
                          <label className="acc-field">
                            <span>วันที่{bill.entryType === "sale" ? "รับเงิน" : "จ่ายเงิน"}</span>
                            <input
                              type="date"
                              value={formOf(bill).payDate}
                              onChange={(e) => patchForm(bill.entryId, { payDate: e.target.value })}
                              disabled={pending}
                            />
                          </label>
                          {bill.currency ? (
                            <>
                              <label className="acc-field">
                                <span>จำนวนเงินตราต่างประเทศ ({bill.currency})</span>
                                <input
                                  className="num"
                                  inputMode="decimal"
                                  value={formOf(bill).fxAmount}
                                  onChange={(e) => patchForm(bill.entryId, { fxAmount: e.target.value })}
                                  placeholder="0.00"
                                  disabled={pending}
                                />
                              </label>
                              <label className="acc-field">
                                <span>อัตราแลกเปลี่ยนวันนี้ (settlement)</span>
                                <input
                                  className="num"
                                  inputMode="decimal"
                                  value={formOf(bill).fxRate}
                                  onChange={(e) => patchForm(bill.entryId, { fxRate: e.target.value })}
                                  placeholder={bill.fxRate ? String(bill.fxRate) : "0.000000"}
                                  disabled={pending}
                                />
                              </label>
                              <div className="acc-field acc-field-wide acc-contra-hint">
                                ยอดที่ตัด AR/AP คำนวณด้วยอัตราตอนออกบิล ({bill.fxRate ?? "—"}) เสมอ ไม่ใช่อัตราวันนี้ —
                                ผลต่างจะเป็นกำไร/ขาดทุนจากอัตราแลกเปลี่ยนที่แนะนำให้ภายหลัง
                              </div>
                            </>
                          ) : (
                            <label className="acc-field">
                              <span>จำนวนเงิน (คงค้าง {formatMoney(bill.outstanding)})</span>
                              <input
                                className="num"
                                inputMode="decimal"
                                value={formOf(bill).amount}
                                onChange={(e) => patchForm(bill.entryId, { amount: e.target.value })}
                                placeholder="0.00"
                                disabled={pending}
                              />
                            </label>
                          )}
                          <label className="acc-field">
                            <span>วิธี{bill.entryType === "sale" ? "รับเงิน" : "จ่ายเงิน"}</span>
                            <select
                              value={formOf(bill).method}
                              onChange={(e) =>
                                patchForm(bill.entryId, { method: e.target.value as BillPaymentMethod })
                              }
                              disabled={pending}
                            >
                              <option value="cash">เงินสด</option>
                              <option value="cheque">เช็ค</option>
                              <option value="transfer">เงินโอน</option>
                            </select>
                          </label>
                          {formOf(bill).method === "transfer" && bankAccounts.length > 0 ? (
                            <label className="acc-field">
                              <span>บัญชีเงินฝาก</span>
                              <select
                                value={formOf(bill).bankAccountId}
                                onChange={(e) => patchForm(bill.entryId, { bankAccountId: e.target.value })}
                                disabled={pending}
                              >
                                <option value="">— ไม่ระบุ —</option>
                                {bankAccounts.map((b) => (
                                  <option key={b.id} value={b.id}>
                                    {b.accountCode} · {b.bankName || ""} {b.accountNo || ""}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                          <label className="acc-field acc-field-wide">
                            <span>หมายเหตุ (ไม่บังคับ)</span>
                            <input
                              type="text"
                              value={formOf(bill).notes}
                              onChange={(e) => patchForm(bill.entryId, { notes: e.target.value })}
                              maxLength={500}
                              disabled={pending}
                            />
                          </label>
                        </div>
                        <div className="acc-modal-actions">
                          <button type="button" className="btn green" onClick={() => submit(bill)} disabled={pending}>
                            {pending ? "กำลังบันทึก…" : "บันทึก"}
                          </button>
                        </div>

                        {bill.payments.length > 0 ? (
                          <div style={{ marginTop: 16 }}>
                            <div className="strong" style={{ marginBottom: 6 }}>
                              ประวัติการ{bill.entryType === "sale" ? "รับเงิน" : "จ่ายเงิน"} ({bill.payments.length})
                            </div>
                            <div className="table-wrap">
                              <table className="dlv-table acc-table">
                                <thead>
                                  <tr>
                                    <th>วันที่</th>
                                    <th>วิธี</th>
                                    <th className="num">จำนวนเงิน</th>
                                    <th>หมายเหตุ</th>
                                    <th>จัดการ</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {bill.payments.map((p) => (
                                    <tr key={p.id}>
                                      <td>{formatDateThai(p.payDate)}</td>
                                      <td>{METHOD_LABELS[p.method]}</td>
                                      <td className="num">{formatMoney(p.amount)}</td>
                                      <td>{p.notes || "—"}</td>
                                      <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                        {/* เฟส 10 ส่วน AA (0.5/0.14) — เห็นเฉพาะงวดที่เป็น FX เท่านั้น */}
                                        {p.currency ? (
                                          p.fxGainLossNoteId ? (
                                            <a
                                              href="/chat-audit/accounting/journal-entry"
                                              className="btn btn-sm btn-ghost"
                                              title="ดู JV กำไร/ขาดทุนจากอัตราแลกเปลี่ยนที่แนะนำไว้แล้ว"
                                            >
                                              ดู JV ที่แนะนำ
                                            </a>
                                          ) : (
                                            <button
                                              type="button"
                                              className="btn btn-sm"
                                              onClick={() => onSuggestFx(p.id)}
                                              disabled={pending}
                                              title="คำนวณ + สร้างร่าง JV กำไร/ขาดทุนจากอัตราแลกเปลี่ยนของงวดนี้ (ต้องไปยืนยันเองที่หน้าลงบัญชีเอง)"
                                            >
                                              แนะนำ JV กำไร/ขาดทุน FX
                                            </button>
                                          )
                                        ) : null}
                                        <button
                                          type="button"
                                          className="btn btn-sm danger"
                                          onClick={() => onVoid(p.id)}
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

                        {/* wishlist ข้อ 7 — แผนงวดผ่อนชำระ (schedule อ้างอิงเท่านั้น ไม่กระทบยอดค้างชำระ/AR-AP) */}
                        <div style={{ marginTop: 16 }}>
                          <div className="strong" style={{ marginBottom: 6 }}>แผนผ่อนชำระ</div>
                          {installmentForms[bill.entryId] ? (
                            <div className="acc-je-form" style={{ marginTop: 0 }}>
                              {installmentForms[bill.entryId].map((row, idx) => (
                                <div key={idx} className="acc-field-grid" style={{ marginBottom: 8 }}>
                                  <label className="acc-field">
                                    <span>งวดที่ {idx + 1} — วันครบกำหนด</span>
                                    <input
                                      type="date"
                                      value={row.dueDate}
                                      onChange={(e) => patchInstallmentRow(bill.entryId, idx, { dueDate: e.target.value })}
                                      disabled={pending}
                                    />
                                  </label>
                                  <label className="acc-field">
                                    <span>ยอดชำระงวดนี้</span>
                                    <input
                                      className="num"
                                      inputMode="decimal"
                                      value={row.amount}
                                      onChange={(e) => patchInstallmentRow(bill.entryId, idx, { amount: e.target.value })}
                                      placeholder="0.00"
                                      disabled={pending}
                                    />
                                  </label>
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-ghost"
                                    onClick={() => removeInstallmentRow(bill.entryId, idx)}
                                    disabled={pending || installmentForms[bill.entryId].length <= 2}
                                    title={installmentForms[bill.entryId].length <= 2 ? "ต้องมีอย่างน้อย 2 งวด" : undefined}
                                  >
                                    ลบงวดนี้
                                  </button>
                                </div>
                              ))}
                              <div className="acc-modal-actions" style={{ marginTop: 0 }}>
                                <button type="button" className="btn btn-ghost btn-sm" onClick={() => addInstallmentRow(bill.entryId)} disabled={pending}>
                                  + เพิ่มงวด
                                </button>
                              </div>
                              <div className="muted" style={{ margin: "8px 0" }}>
                                รวม {formatMoney(installmentRowsTotal(bill.entryId))} / ต้องเท่ากับยอดเต็มบิล {formatMoney(bill.netTotal)}
                              </div>
                              <div className="acc-modal-actions">
                                <button type="button" className="btn green" onClick={() => submitInstallmentPlan(bill)} disabled={pending}>
                                  {pending ? "กำลังบันทึก…" : "บันทึกแผน"}
                                </button>
                                <button type="button" className="btn btn-ghost" onClick={() => closeInstallmentEdit(bill.entryId)} disabled={pending}>
                                  ยกเลิก
                                </button>
                              </div>
                            </div>
                          ) : bill.installments.length > 0 ? (
                            <>
                              {bill.hasNoteAdjustment ? (
                                <div className="muted" style={{ marginBottom: 8 }}>
                                  ⚠️ บิลนี้มีใบลด/เพิ่มหนี้ปรับยอดอยู่ — สถานะงวดด้านล่างคำนวณจากยอดเต็มบิลเดิมตอนตั้งแผน
                                  อาจไม่ตรงกับยอดคงค้างจริง ให้ดูยอดค้างชำระที่คอลัมน์ด้านบนของตารางเป็นหลัก
                                </div>
                              ) : null}
                              <div className="table-wrap">
                                <table className="dlv-table acc-table">
                                  <thead>
                                    <tr>
                                      <th>งวดที่</th>
                                      <th>วันครบกำหนด</th>
                                      <th className="num">ยอดตามแผน</th>
                                      <th>สถานะ</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {computeInstallmentStatuses(
                                      bill.installments,
                                      bill.payments.reduce((s, p) => s + p.amount, 0),
                                      todayIso()
                                    ).map((inst) => (
                                      <tr key={inst.id}>
                                        <td>{inst.installmentNo}</td>
                                        <td>{formatDateThai(inst.dueDate)}</td>
                                        <td className="num">{formatMoney(inst.plannedAmount)}</td>
                                        <td>
                                          <span className={`st-badge ${INSTALLMENT_STATUS_CLASS[inst.status]}`}>
                                            {INSTALLMENT_STATUS_LABELS[inst.status]}
                                          </span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <div className="acc-modal-actions">
                                <button type="button" className="btn btn-sm" onClick={() => openInstallmentEdit(bill)} disabled={pending}>
                                  แก้ไขแผน
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm danger"
                                  onClick={() => onClearInstallmentPlan(bill.entryId)}
                                  disabled={pending}
                                >
                                  ลบแผน
                                </button>
                              </div>
                            </>
                          ) : (
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => openInstallmentEdit(bill)} disabled={pending}>
                              + ตั้งแผนผ่อนชำระ
                            </button>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
