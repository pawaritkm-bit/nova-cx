"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveCustomerTaxIdAction } from "./actions";
import { normalizeTaxId, taxIdDigits, TAX_ID_LENGTH } from "@/lib/accounting/tax-id";

/**
 * ช่องกรอก "เลขภาษีของลูกค้า" ต่อ 1 ราย (client) — ในการ์ดลูกค้าหน้า /chat-audit/accounting
 *
 * บริบท (loop เก็บเลขภาษี): บิลที่ไม่มีเลขภาษีให้ AI อ่าน → จับซื้อ/ขายไม่ได้.
 *   นักบัญชีกรอกเลขภาษีที่ขาด → server (1) จำที่ customers.tax_id (2) re-decide บิลรายนั้น
 *   (3) ส่งกลับ NOVA Sale. มีอยู่แล้ว → โชว์ค่าเดิม (แก้ได้).
 *
 * ★ validate ฝั่ง client เบา ๆ (13 หลักหลัง strip) กันยิงเปล่า — ความจริงตัดสินที่ server
 * ★ ระหว่างบันทึก disable กันกดซ้ำ + refresh หน้าเมื่อสำเร็จ (ให้ badge ซื้อ/ขายอัปเดต)
 */
export default function CustomerTaxIdField({
  customerId,
  initialTaxId,
}: {
  customerId: string;
  initialTaxId: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialTaxId ?? "");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const hasInitial = !!initialTaxId;
  const digits = taxIdDigits(value);
  const valid = normalizeTaxId(value) !== null;
  // เปลี่ยนจากค่าเดิมไหม (strip แล้วเทียบ) — ไม่เปลี่ยน = ไม่ต้องบันทึกซ้ำ
  const changed = digits !== taxIdDigits(initialTaxId ?? "");

  function save() {
    setMsg(null);
    if (!valid) {
      setMsg({ ok: false, text: "เลขภาษีต้องเป็นตัวเลข 13 หลัก" });
      return;
    }
    startTransition(async () => {
      const res = await saveCustomerTaxIdAction({ customerId, taxId: value });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="acc-taxid-field">
      <label className="acc-taxid-label" htmlFor={`taxid-${customerId}`}>
        เลขภาษีลูกค้า
      </label>
      <input
        id={`taxid-${customerId}`}
        type="text"
        inputMode="numeric"
        className="acc-taxid-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="เลขผู้เสียภาษี 13 หลัก"
        maxLength={20}
        aria-label="เลขประจำตัวผู้เสียภาษีของลูกค้า"
        disabled={pending}
      />
      <button
        type="button"
        className="btn"
        onClick={save}
        disabled={pending || !changed}
        title={hasInitial ? "แก้เลขภาษี" : "บันทึกเลขภาษี"}
      >
        {pending ? "กำลังบันทึก…" : "บันทึกเลขภาษี"}
      </button>
      {!hasInitial ? (
        <span className="acc-taxid-hint">
          ยังไม่มีเลขภาษี — กรอกเพื่อให้ระบบจับ ซื้อ/ขาย ให้อัตโนมัติ
        </span>
      ) : null}
      {value && !valid ? (
        <span className="acc-taxid-count">{digits.length}/{TAX_ID_LENGTH}</span>
      ) : null}
      {msg ? (
        <span className={`acc-taxid-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</span>
      ) : null}
    </div>
  );
}
