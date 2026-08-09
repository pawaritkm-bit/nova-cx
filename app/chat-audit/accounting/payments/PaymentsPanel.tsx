"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recordBillPaymentAction, voidBillPaymentAction } from "./actions";
import { AGING_BUCKET_LABELS, type AgingBucketKey } from "@/lib/accounting/aging";
import type { BillPayment, BillPaymentMethod } from "@/lib/accounting/bill-payments";
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

type FormState = {
  payDate: string;
  amount: string;
  method: BillPaymentMethod;
  bankAccountId: string;
  notes: string;
};

function blankForm(outstanding: number): FormState {
  return { payDate: todayIso(), amount: outstanding > 0 ? String(outstanding) : "", method: "cash", bankAccountId: "", notes: "" };
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

  const formOf = (bill: PaymentBillRow): FormState => forms[bill.entryId] ?? blankForm(bill.outstanding);
  const patchForm = (entryId: string, patch: Partial<FormState>) => {
    setForms((prev) => ({ ...prev, [entryId]: { ...(prev[entryId] ?? blankForm(0)), ...patch } }));
  };

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
                                      <td>
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
