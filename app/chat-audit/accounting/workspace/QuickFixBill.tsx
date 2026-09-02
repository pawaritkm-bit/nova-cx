"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import AccountCombobox from "../AccountCombobox";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { contraAccountFor, moneyAccountOptions } from "@/lib/accounting/payment";
import { formatMoney } from "@/lib/accounting/calc";
import type { PaymentMethod } from "@/lib/accounting/queries";
import { quickFixBillAction } from "./quickfix-actions";
import { applyStatementAccountToBillAction } from "../statement-actions";

/**
 * กล่องลงบัญชีบนการ์ดบิล (โต๊ะทำงาน · บิลร่าง) — ★ 2026-09-02 ดีไซน์ที่ผู้ใช้อนุมัติ:
 *   แถวบน: [คู่ค้า (พิมพ์แก้)] [⇄ สลับซื้อ↔ขาย]
 *   กล่อง "การลงบัญชี": เดบิตบน · เครดิตล่าง — แก้เลขได้ทั้งสองบรรทัด (รวมที่ AI กรอก):
 *     - ฝั่งเงิน (บิลขาย=เดบิต · บิลซื้อ=เครดิต): เลือก 1010/1020/เช็ค/เชื่อ → วิธีรับ-จ่ายปรับตาม
 *     - ฝั่งรายได้/ค่าใช้จ่าย: เขียนลงบรรทัดบิลจริง + ระบบจำรายลูกค้า
 *   VAT/หัก ณ ที่จ่าย ระบบแตกบรรทัดให้เองตอนเข้าสมุด (กล่องนี้โชว์คู่หลัก)
 */
export default function QuickFixBill({
  customerId,
  entryId,
  entryType,
  counterpartyName,
  accountCode,
  accountName,
  lineAmount,
  netAmount,
  paymentMethod,
  paymentBankAccountCode,
  chart,
}: {
  customerId: string;
  entryId: string;
  entryType: "purchase" | "sale" | "unspecified";
  counterpartyName: string | null;
  accountCode: string | null;
  accountName: string | null;
  /** ยอดบรรทัดแรก (ฝั่งรายได้/ค่าใช้จ่าย) — ใช้โชว์ + สอน learning "ยอดซ้ำ" */
  lineAmount: number | null;
  /** ยอดเงินจริงที่วิ่งผ่านฝั่งเงิน (รวม VAT หัก WHT แล้ว) */
  netAmount: number | null;
  paymentMethod: PaymentMethod | null;
  paymentBankAccountCode: string | null;
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

  const chartByCode = buildChartByCode(chart);
  const known = entryType === "sale" || entryType === "purchase";
  const contra = known
    ? contraAccountFor(chartByCode, paymentMethod ?? "credit", entryType, paymentBankAccountCode)
    : null;
  // ตัวเลือกฝั่งเงิน (เงินสด/ธนาคาร/เช็ค/เชื่อ) — แปลงเป็น ChartAccount ให้ combobox เดิมใช้ได้
  const moneyChart: ChartAccount[] = known
    ? moneyAccountOptions(chartByCode, entryType, paymentBankAccountCode).map((o) => ({
        code: o.code,
        name: o.name,
        category: chartByCode[o.code]?.category ?? "สินทรัพย์",
        bank: false,
      }))
    : [];

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
        if (r.counterpartyName) setCp(r.counterpartyName);
        router.refresh();
      }
    });
  };

  const pickMoney = (code: string) => {
    startTransition(async () => {
      const r = await quickFixBillAction({ customerId, entryId, moneyAccountCode: code });
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  };

  const pickLine = (code: string, name: string) => {
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
      setMsg({ ok: r.ok, text: r.ok ? "บันทึกบัญชีแล้ว (ระบบจำของลูกค้ารายนี้)" : r.message ?? "บันทึกไม่สำเร็จ" });
      if (r.ok) router.refresh();
    });
  };

  // เดบิตอยู่บนเสมอ: ขาย → เดบิต=ฝั่งเงิน · ซื้อ → เดบิต=ฝั่งค่าใช้จ่าย
  const moneyRow = (
    <div className="wsp-jrow" key="money">
      <span className={`wsp-jside ${entryType === "sale" ? "dr" : "cr"}`}>
        {entryType === "sale" ? "เดบิต" : "เครดิต"}
      </span>
      <div className="wsp-jacct">
        <AccountCombobox
          accountCode={contra?.code ?? ""}
          accountName={contra?.name ?? ""}
          chart={moneyChart}
          readOnly={busy}
          onSelect={(code) => pickMoney(code)}
          onNameChange={() => {}}
          onClear={() => {}}
        />
      </div>
      <span className="wsp-jamt">{netAmount != null ? formatMoney(netAmount) : "—"}</span>
    </div>
  );
  const lineRow = (
    <div className="wsp-jrow" key="line">
      <span className={`wsp-jside ${entryType === "sale" ? "cr" : "dr"}`}>
        {entryType === "sale" ? "เครดิต" : "เดบิต"}
      </span>
      <div className="wsp-jacct">
        <AccountCombobox
          accountCode={acct.code}
          accountName={acct.name}
          chart={chart}
          readOnly={busy}
          onSelect={pickLine}
          onNameChange={(n) => acct.code && pickLine(acct.code, n)}
          onClear={() => setAcct({ code: "", name: "" })}
        />
      </div>
      <span className="wsp-jamt">{lineAmount != null ? formatMoney(lineAmount) : "—"}</span>
    </div>
  );

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
        disabled={busy || !known}
        title="สลับซื้อ↔ขาย (สลับฝั่งเดบิต/เครดิตทั้งใบ)"
      >
        ⇄ {entryType === "sale" ? "สลับเป็นซื้อ" : entryType === "purchase" ? "สลับเป็นขาย" : "สลับ Dr/Cr"}
      </button>
      {known ? (
        <div className="wsp-jbox">
          <div className="wsp-jbox-title">การลงบัญชี — แก้เลขได้ทั้งสองบรรทัด (รวมที่ AI กรอก)</div>
          {entryType === "sale" ? [moneyRow, lineRow] : [lineRow, moneyRow]}
        </div>
      ) : (
        <span className="muted" style={{ fontSize: 12 }}>ระบุประเภทซื้อ/ขายก่อน จึงลงเดบิต/เครดิตได้</span>
      )}
      {msg ? (
        <span style={{ fontSize: 11, color: msg.ok ? "#166534" : "#b91c1c", flexBasis: "100%" }}>
          {msg.ok ? "✓ " : "⚠ "}{msg.text}
        </span>
      ) : null}
    </div>
  );
}
