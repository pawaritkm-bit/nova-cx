"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import AccountCombobox from "../AccountCombobox";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { quickFixBillAction } from "./quickfix-actions";
import { applyStatementAccountToBillAction } from "../statement-actions";

/**
 * แผงแก้ไขด่วนบนการ์ดบิล (โต๊ะทำงาน · เฉพาะบิลร่าง) — ★ 2026-09-02 ผู้ใช้:
 * "AI จับผิดอยู่ แก้ไม่ได้" → แก้ตรงการ์ดได้ 3 อย่างโดยไม่ต้องเปิดตัวแก้เต็ม:
 *   1) คู่ค้า (พิมพ์ทับ · เว้นเคาะแล้วบันทึกเอง)
 *   2) ⇄ สลับซื้อ↔ขาย = สลับฝั่งเดบิต/เครดิตทั้งใบ
 *   3) บัญชี (combobox เดียวกับทุกหน้า) — เขียนลงบรรทัดบิลจริง + ระบบจำ "รายลูกค้า"
 */
export default function QuickFixBill({
  customerId,
  entryId,
  entryType,
  counterpartyName,
  accountCode,
  accountName,
  lineAmount,
  chart,
}: {
  customerId: string;
  entryId: string;
  entryType: "purchase" | "sale" | "unspecified";
  counterpartyName: string | null;
  accountCode: string | null;
  accountName: string | null;
  /** ยอดบรรทัดแรก — ใช้สอน learning "ยอดซ้ำ" */
  lineAmount: number | null;
  chart: ChartAccount[];
}) {
  const router = useRouter();
  const [cp, setCp] = useState(counterpartyName ?? "");
  const [acct, setAcct] = useState<{ code: string; name: string }>({
    code: accountCode ?? "",
    name: accountName ?? "",
  });
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const saveCp = () => {
    if ((counterpartyName ?? "") === cp.trim()) return;
    startTransition(async () => {
      const r = await quickFixBillAction({ customerId, entryId, counterpartyName: cp });
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  };

  const flip = () => {
    startTransition(async () => {
      const r = await quickFixBillAction({ customerId, entryId, flipType: true });
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) {
        if (r.counterpartyName !== undefined && r.counterpartyName !== null) setCp(r.counterpartyName);
        router.refresh();
      }
    });
  };

  const pickAccount = (code: string, name: string) => {
    setAcct({ code, name });
    startTransition(async () => {
      const r = await applyStatementAccountToBillAction({
        customerId,
        billId: entryId,
        accountCode: code,
        accountName: name,
        counterpartyName: cp || counterpartyName,
        amount: lineAmount,
      });
      setMsg({ ok: r.ok, text: r.ok ? "บันทึกบัญชีแล้ว (ระบบจำของลูกค้ารายนี้)" : r.message ?? "บันทึกบัญชีไม่สำเร็จ" });
      if (r.ok) router.refresh();
    });
  };

  return (
    <div className="wsp-quickfix">
      <input
        type="text"
        value={cp}
        placeholder="คู่ค้า (ชื่อผู้โอน/ผู้ขาย)"
        onChange={(e) => setCp(e.target.value)}
        onBlur={saveCp}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        disabled={busy}
        aria-label="แก้คู่ค้า"
      />
      <button
        type="button"
        className="wsp-btn ghost"
        onClick={flip}
        disabled={busy || entryType === "unspecified"}
        title="สลับซื้อ↔ขาย (สลับฝั่งเดบิต/เครดิตทั้งใบ)"
      >
        ⇄ {entryType === "sale" ? "สลับเป็นซื้อ" : entryType === "purchase" ? "สลับเป็นขาย" : "สลับ Dr/Cr"}
      </button>
      <div className="wsp-quickfix-acct">
        <AccountCombobox
          accountCode={acct.code}
          accountName={acct.name}
          chart={chart}
          readOnly={false}
          onSelect={pickAccount}
          onNameChange={(n) => acct.code && pickAccount(acct.code, n)}
          onClear={() => setAcct({ code: "", name: "" })}
        />
      </div>
      {msg ? (
        <span style={{ fontSize: 11, color: msg.ok ? "#166534" : "#b91c1c", flexBasis: "100%" }}>
          {msg.ok ? "✓ " : "⚠ "}{msg.text}
        </span>
      ) : null}
    </div>
  );
}
