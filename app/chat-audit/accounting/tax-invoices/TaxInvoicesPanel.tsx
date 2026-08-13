"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { issueTaxInvoiceAction, voidTaxInvoiceAction } from "./actions";
import { formatMoney } from "@/lib/accounting/calc";

/**
 * TaxInvoicesPanel — 1 ตารางต่อลูกค้า: ทุกบิลขายที่ยืนยันแล้วของลูกค้ารายนี้ พร้อมสถานะใบกำกับภาษี
 *   - ยังไม่ออก → ปุ่ม "ออกใบกำกับภาษี" (เปิดฟอร์มอินไลน์ใต้แถว — ไม่มี draft, กดครั้งเดียวออกเลขที่เลย)
 *   - ออกแล้ว → เลขที่ + รูปแบบ + ลิงก์พิมพ์ + ปุ่มยกเลิก (void)
 *
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope ที่ actions.ts)
 */

export type EligibleBillRow = {
  entryId: string;
  docNo: string | null;
  docDate: string | null;
  counterpartyName: string | null;
  counterpartyTaxId: string | null;
  netTotal: number;
  issuedInvoiceId: string | null;
  issuedDocNo: string | null;
  issuedFormLabel: string | null;
};

type FormType = "full" | "abbreviated";

type FormState = {
  formType: FormType;
  docDate: string;
  buyerName: string;
  buyerTaxId: string;
  buyerAddress: string;
  buyerBranch: string;
  sellerBranch: string;
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

function blankForm(row: EligibleBillRow): FormState {
  return {
    formType: "full",
    docDate: todayIso(),
    buyerName: row.counterpartyName ?? "",
    buyerTaxId: row.counterpartyTaxId ?? "",
    buyerAddress: "",
    buyerBranch: "",
    sellerBranch: "",
  };
}

export default function TaxInvoicesPanel({
  customerId,
  bills,
}: {
  customerId: string;
  bills: EligibleBillRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const sorted = useMemo(
    () => [...bills].sort((a, b) => (b.docDate ?? "").localeCompare(a.docDate ?? "")),
    [bills]
  );

  function openIssue(row: EligibleBillRow) {
    setOpenFor(row.entryId);
    setForm(blankForm(row));
    setMsg(null);
  }
  function closeIssue() {
    setOpenFor(null);
    setForm(null);
  }
  function patch(p: Partial<FormState>) {
    setForm((prev) => (prev ? { ...prev, ...p } : prev));
  }

  function submitIssue(entryId: string) {
    if (!form) return;
    if (form.formType === "full" && (!form.buyerName.trim() || !form.buyerTaxId.trim())) {
      setMsg({ ok: false, text: "ใบกำกับภาษีเต็มรูปต้องระบุชื่อและเลขประจำตัวผู้เสียภาษีของผู้ซื้อ" });
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await issueTaxInvoiceAction({
        customerId,
        billEntryId: entryId,
        formType: form.formType,
        docDate: form.docDate,
        buyerName: form.buyerName || null,
        buyerTaxId: form.buyerTaxId || null,
        buyerAddress: form.buyerAddress || null,
        buyerBranch: form.buyerBranch || null,
        sellerBranch: form.sellerBranch || null,
      });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        closeIssue();
        router.refresh();
      }
    });
  }

  function onVoid(invoiceId: string) {
    if (!window.confirm("ยกเลิกใบกำกับภาษีนี้? เลขที่เดิมจะไม่ถูกนำกลับมาใช้ซ้ำ (ออกใหม่ได้เลขใหม่เท่านั้น)")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await voidTaxInvoiceAction(invoiceId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="acc-je">
      {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}

      <div className="table-wrap">
        <table className="dlv-table acc-table">
          <thead>
            <tr>
              <th>เลขที่บิล</th>
              <th>วันที่</th>
              <th>คู่ค้า</th>
              <th className="num">ยอดสุทธิ</th>
              <th>ใบกำกับภาษี</th>
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">ยังไม่มีบิลขายที่ยืนยันแล้วของลูกค้ารายนี้</td>
              </tr>
            ) : (
              sorted.map((row) => (
                <Fragment key={row.entryId}>
                  <tr>
                    <td>{row.docNo || "—"}</td>
                    <td>{formatDateThai(row.docDate)}</td>
                    <td>{row.counterpartyName || "—"}</td>
                    <td className="num">{formatMoney(row.netTotal)}</td>
                    <td>
                      {row.issuedInvoiceId ? (
                        <span>
                          {row.issuedDocNo} <span className="acc-subtab-n">{row.issuedFormLabel}</span>
                        </span>
                      ) : (
                        <span className="empty">ยังไม่ออก</span>
                      )}
                    </td>
                    <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {!row.issuedInvoiceId ? (
                        <button
                          type="button"
                          className="btn btn-sm green"
                          onClick={() => (openFor === row.entryId ? closeIssue() : openIssue(row))}
                          disabled={pending}
                        >
                          {openFor === row.entryId ? "ปิดฟอร์ม" : "ออกใบกำกับภาษี"}
                        </button>
                      ) : (
                        <>
                          <a
                            href={`/chat-audit/accounting/tax-invoices/${row.issuedInvoiceId}/print`}
                            className="btn btn-sm"
                            target="_blank"
                            rel="noopener"
                          >
                            พิมพ์
                          </a>
                          <button
                            type="button"
                            className="btn btn-sm danger"
                            onClick={() => onVoid(row.issuedInvoiceId as string)}
                            disabled={pending}
                          >
                            ยกเลิก
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {openFor === row.entryId && form ? (
                    <tr>
                      <td colSpan={6}>
                        <div className="acc-je-form">
                          <div className="acc-field-grid">
                            <label className="acc-field">
                              <span>รูปแบบ</span>
                              <select
                                value={form.formType}
                                onChange={(e) => patch({ formType: e.target.value === "abbreviated" ? "abbreviated" : "full" })}
                                disabled={pending}
                              >
                                <option value="full">เต็มรูป</option>
                                <option value="abbreviated">อย่างย่อ</option>
                              </select>
                            </label>
                            <label className="acc-field">
                              <span>วันที่เอกสาร</span>
                              <input
                                type="date"
                                value={form.docDate}
                                onChange={(e) => patch({ docDate: e.target.value })}
                                disabled={pending}
                              />
                            </label>
                            <label className="acc-field acc-field-wide">
                              <span>ชื่อผู้ซื้อ{form.formType === "full" ? " *" : ""}</span>
                              <input
                                type="text"
                                value={form.buyerName}
                                onChange={(e) => patch({ buyerName: e.target.value })}
                                maxLength={200}
                                disabled={pending}
                              />
                            </label>
                            <label className="acc-field">
                              <span>เลขผู้เสียภาษีผู้ซื้อ{form.formType === "full" ? " *" : ""}</span>
                              <input
                                type="text"
                                value={form.buyerTaxId}
                                onChange={(e) => patch({ buyerTaxId: e.target.value })}
                                maxLength={20}
                                disabled={pending}
                              />
                            </label>
                            <label className="acc-field acc-field-wide">
                              <span>ที่อยู่ผู้ซื้อ</span>
                              <input
                                type="text"
                                value={form.buyerAddress}
                                onChange={(e) => patch({ buyerAddress: e.target.value })}
                                maxLength={300}
                                disabled={pending}
                              />
                            </label>
                            <label className="acc-field">
                              <span>สาขาผู้ซื้อ</span>
                              <input
                                type="text"
                                value={form.buyerBranch}
                                onChange={(e) => patch({ buyerBranch: e.target.value })}
                                maxLength={50}
                                disabled={pending}
                              />
                            </label>
                            <label className="acc-field">
                              <span>สาขาผู้ขาย</span>
                              <input
                                type="text"
                                value={form.sellerBranch}
                                onChange={(e) => patch({ sellerBranch: e.target.value })}
                                maxLength={50}
                                disabled={pending}
                              />
                            </label>
                          </div>
                          <div className="acc-modal-actions">
                            <button
                              type="button"
                              className="btn green"
                              onClick={() => submitIssue(row.entryId)}
                              disabled={pending}
                            >
                              {pending ? "กำลังออกเอกสาร…" : "ยืนยันออกใบกำกับภาษี"}
                            </button>
                            <button type="button" className="btn btn-ghost" onClick={closeIssue} disabled={pending}>
                              ยกเลิก
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
