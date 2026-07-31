"use client";

import { useMemo, useState, useTransition } from "react";
import {
  upsertCustomerBankAccountAction,
  deleteCustomerBankAccountAction,
} from "./actions";
import { BANK_ACCOUNTS } from "@/lib/accounting/chart-of-accounts";
import type { CustomerBankAccount } from "@/lib/accounting/bank-accounts";

/**
 * BankAccountsPanel — แผงจัดการ "บัญชีเงินฝากธนาคารของลูกค้า" (แยกเลขบัญชีต่อลูกค้า)
 *
 * บริบท: ผังบัญชีกลางเก็บบัญชีเงินฝากเป็น generic (#1/#2/#3) เท่านั้น.
 *   เลขบัญชีจริงของแต่ละบริษัทตั้งที่นี่ (customer_bank_accounts) — หน้าตรวจบิลเลือกบัญชี
 *   ของ "ลูกค้าเจ้าของบิล" เท่านั้น (กันหลุดข้ามบริษัท / PDPA).
 *
 * ★ 1 ลูกค้ามีได้สูงสุดเท่าจำนวนรหัสเงินฝากในผังกลาง (ปัจจุบัน 3: 1020/1025/1030)
 *   — unique (customer_id, account_code) ที่ DB กันซ้ำ, ที่นี่กันเลือกรหัสซ้ำใน UI ด้วย
 * ★ รหัสบัญชี (account_code) ล็อกเป็นรหัสผังเงินฝาก · ชื่อธนาคาร/เลขบัญชี = แก้ได้
 * ★ ทุกการเขียนผ่าน server action (guard admin + customer scope + service-role)
 */

type Row = {
  /** key ใน UI (id ของ row จริง หรือ n<seq> สำหรับ row ใหม่) */
  key: string;
  /** id ใน DB (undefined = ยังไม่บันทึก) */
  id?: string;
  accountCode: string;
  bankName: string;
  accountNo: string;
};

let seq = 0;
const newKey = () => `n${(seq += 1)}`;

function toRows(initial: CustomerBankAccount[]): Row[] {
  return initial.map((b) => ({
    key: b.id,
    id: b.id,
    accountCode: b.accountCode,
    bankName: b.bankName ?? "",
    accountNo: b.accountNo ?? "",
  }));
}

export default function BankAccountsPanel({
  customerId,
  customerLabel,
  initial,
  onClose,
}: {
  customerId: string;
  customerLabel: string;
  initial: CustomerBankAccount[];
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(initial));
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // รหัสเงินฝากที่ "ยังว่าง" (ไม่ถูกใช้โดย row อื่น) — สำหรับ default ของ row ใหม่
  const usedCodes = useMemo(() => new Set(rows.map((r) => r.accountCode)), [rows]);
  const freeCodes = useMemo(
    () => BANK_ACCOUNTS.filter((a) => !usedCodes.has(a.code)),
    [usedCodes]
  );

  const patch = (key: string, p: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const addRow = () => {
    const first = freeCodes[0];
    if (!first) {
      setMsg({ ok: false, text: "ผูกบัญชีครบทุกรหัสเงินฝากแล้ว" });
      return;
    }
    setRows((prev) => [
      ...prev,
      { key: newKey(), accountCode: first.code, bankName: "", accountNo: "" },
    ]);
  };

  const saveRow = (row: Row) => {
    setMsg(null);
    startTransition(async () => {
      const res = await upsertCustomerBankAccountAction({
        customerId,
        id: row.id,
        accountCode: row.accountCode,
        bankName: row.bankName || null,
        accountNo: row.accountNo || null,
      });
      setMsg({ ok: res.ok, text: res.message });
    });
  };

  const removeRow = (row: Row) => {
    // row ที่ยังไม่บันทึก → เอาออกจาก UI เฉย ๆ
    if (!row.id) {
      setRows((prev) => prev.filter((r) => r.key !== row.key));
      return;
    }
    if (!window.confirm("ลบบัญชีธนาคารนี้ของลูกค้า?")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteCustomerBankAccountAction(row.id!);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setRows((prev) => prev.filter((r) => r.key !== row.key));
      }
    });
  };

  // ปิดแผง — parent (EntryEditor) เรียก router.refresh ให้ picker เห็นค่าใหม่
  const close = () => onClose();

  return (
    <div className="acc-modal-backdrop" role="dialog" aria-modal="true" aria-label="บัญชีธนาคารของลูกค้า">
      <button type="button" className="acc-modal-scrim" aria-label="ปิด" onClick={close} />
      <div className="acc-modal acc-modal-sm">
        <div className="acc-modal-head">
          <div>
            <div className="acc-modal-title">🏦 บัญชีธนาคารของลูกค้า</div>
            <div className="acc-modal-sub">{customerLabel}</div>
          </div>
          <button type="button" className="acc-modal-close" onClick={close} aria-label="ปิด">✕</button>
        </div>

        <div className="acc-bank-panel">
          <p className="acc-bank-hint">
            เลขบัญชีเงินฝากของลูกค้ารายนี้ (แยกต่อลูกค้า ไม่ปนบริษัทอื่น) — เลือกได้ในช่องบัญชีของแต่ละบรรทัดบิล
          </p>

          {rows.length === 0 ? (
            <div className="acc-bank-empty">ยังไม่มีบัญชีธนาคาร — กด “＋ เพิ่มบัญชี” ด้านล่าง</div>
          ) : (
            <div className="acc-bank-list">
              {rows.map((row) => {
                // ตัวเลือกรหัส = รหัสที่ยังว่าง + รหัสของแถวนี้เอง (ไม่ให้เลือกซ้ำแถวอื่น)
                const codeOptions = BANK_ACCOUNTS.filter(
                  (a) => a.code === row.accountCode || !usedCodes.has(a.code)
                );
                return (
                  <div className="acc-bank-row" key={row.key}>
                    <select
                      className="acc-bank-code"
                      value={row.accountCode}
                      onChange={(e) => patch(row.key, { accountCode: e.target.value })}
                      disabled={pending}
                      aria-label="รหัสบัญชีเงินฝาก"
                      title="รหัสผังบัญชีเงินฝาก (1020/1025/1030)"
                    >
                      {codeOptions.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      className="acc-bank-name"
                      value={row.bankName}
                      onChange={(e) => patch(row.key, { bankName: e.target.value })}
                      placeholder="ชื่อธนาคาร (เช่น กสิกรไทย)"
                      maxLength={80}
                      disabled={pending}
                      aria-label="ชื่อธนาคาร"
                    />
                    <input
                      type="text"
                      className="acc-bank-no"
                      value={row.accountNo}
                      onChange={(e) => patch(row.key, { accountNo: e.target.value })}
                      placeholder="เลขที่บัญชี"
                      maxLength={40}
                      disabled={pending}
                      aria-label="เลขที่บัญชี"
                    />
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
                      aria-label="ลบบัญชี"
                      title="ลบบัญชี"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <button
            type="button"
            className="acc-add-line"
            onClick={addRow}
            disabled={pending || freeCodes.length === 0}
          >
            ＋ เพิ่มบัญชี
          </button>

          {msg ? (
            <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>
          ) : null}

          <div className="acc-modal-actions">
            <span className="acc-toolbar-spacer" />
            <button type="button" className="btn btn-ghost" onClick={close} disabled={pending}>
              เสร็จสิ้น
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
