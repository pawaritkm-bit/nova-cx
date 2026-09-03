"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import AccountCombobox from "../AccountCombobox";
import { buildChartByCode, type ChartAccount } from "@/lib/accounting/chart-of-accounts";
import { contraAccountFor, moneyAccountOptions } from "@/lib/accounting/payment";
import { formatMoney, parseAmountInput, round2 } from "@/lib/accounting/calc";
import type { PaymentMethod } from "@/lib/accounting/queries";
import {
  quickFixBillAction,
  setBillLineAccountAction,
  patchBillLineAmountsAction,
} from "./quickfix-actions";
import { confirmEntryDirectAction } from "../actions";

/** ข้อมูลบรรทัดที่การ์ดต้องใช้ (serializable จาก server page) */
export type CardLine = {
  id: string;
  description: string | null;
  accountCode: string | null;
  accountName: string | null;
  amount: number;
  vatAmount: number;
  whtRate: number;
  whtAmount: number;
};

/**
 * การ์ดบิล "หลายรายการ" (โต๊ะทำงาน) — ★ 2026-09-03 ผู้ใช้อนุมัติดีไซน์ ("โอเคทำเลย"):
 *   ตารางบรรทัดละช่องเลขผัง + ยอดต่อบรรทัด (มูลค่า/VAT/หัก %/หัก ณ ที่จ่าย — แก้ได้ Tab เดินช่อง)
 *   - Enter ที่ช่องเลขผัง = บันทึกบรรทัด → โฟกัสเด้งไปช่องเลขผังถัดไปที่ยังว่าง
 *   - ครบทุกบรรทัด = ยืนยันบิลอัตโนมัติ (เข้าสมุด/รายงานทันที — ผิดค่อยแก้หน้ากระทบยอด)
 *   - มูลค่า/VAT/หัก % แก้แล้วบันทึกตอน blur · หัก ณ ที่จ่าย = มูลค่า×อัตรา คำนวณให้เอง
 */
export default function MultiLineQuickFix({
  customerId,
  entryId,
  entryType,
  counterpartyName,
  lines,
  netAmount,
  paymentMethod,
  paymentBankAccountCode,
  chart,
}: {
  customerId: string;
  entryId: string;
  entryType: "purchase" | "sale" | "unspecified";
  counterpartyName: string | null;
  lines: CardLine[];
  netAmount: number | null;
  paymentMethod: PaymentMethod | null;
  paymentBankAccountCode: string | null;
  chart: ChartAccount[];
}) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const [cp, setCp] = useState(counterpartyName ?? "");
  const [rows, setRows] = useState<CardLine[]>(lines);
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // โฟกัสช่องเลขผังว่างช่องถัดไปหลังบันทึกสำเร็จ (ทำใน effect หลัง re-render)
  const [focusEmptyTick, setFocusEmptyTick] = useState(0);

  const chartByCode = buildChartByCode(chart);
  const known = entryType === "sale" || entryType === "purchase";
  const contra = known
    ? contraAccountFor(chartByCode, paymentMethod ?? "credit", entryType, paymentBankAccountCode)
    : null;
  const moneyChart: ChartAccount[] = known
    ? moneyAccountOptions(chartByCode, entryType, paymentBankAccountCode).map((o) => ({
        code: o.code,
        name: o.name,
        category: chartByCode[o.code]?.category ?? "สินทรัพย์",
        bank: false,
      }))
    : [];

  const doneCount = rows.filter((r) => (r.accountCode ?? "").trim()).length;
  const totals = rows.reduce(
    (t, r) => ({
      amount: round2(t.amount + r.amount),
      vat: round2(t.vat + r.vatAmount),
      wht: round2(t.wht + r.whtAmount),
    }),
    { amount: 0, vat: 0, wht: 0 }
  );

  useEffect(() => {
    if (focusEmptyTick === 0) return;
    const el = rootRef.current?.querySelector<HTMLInputElement>(".wsp-ml-acct input");
    el?.focus();
  }, [focusEmptyTick]);

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

  /** เลือกเลขผังของบรรทัด — สำเร็จแล้ว: ครบทุกบรรทัด = ยืนยันอัตโนมัติ · ไม่ครบ = เด้งช่องถัดไป */
  const pickLineAccount = (lineId: string, code: string, name: string) => {
    const line = rows.find((r) => r.id === lineId);
    setRows((prev) => prev.map((r) => (r.id === lineId ? { ...r, accountCode: code, accountName: name } : r)));
    startTransition(async () => {
      const r = await setBillLineAccountAction({
        customerId,
        entryId,
        lineId,
        accountCode: code,
        accountName: name,
        counterpartyName: cp || counterpartyName,
        amount: line?.amount ?? null,
      });
      if (!r.ok) {
        setMsg({ ok: false, text: r.message ?? "บันทึกไม่สำเร็จ" });
        return;
      }
      const stillEmpty = rows.filter((x) => x.id !== lineId && !(x.accountCode ?? "").trim()).length;
      if (stillEmpty > 0) {
        setMsg({ ok: true, text: `บันทึกบัญชีแล้ว — เหลืออีก ${stillEmpty} บรรทัด` });
        setFocusEmptyTick((t) => t + 1);
        return;
      }
      // ครบทุกบรรทัด → ยืนยันอัตโนมัติ
      const conf = await confirmEntryDirectAction(entryId);
      setMsg({
        ok: conf.ok,
        text: conf.ok
          ? "บันทึกบัญชีครบทุกบรรทัด + ยืนยันบิลแล้ว ✓"
          : `บันทึกบัญชีครบแล้ว แต่ยังยืนยันไม่ได้: ${conf.message}`,
      });
      router.refresh();
    });
  };

  /** แก้ยอดบรรทัด (blur) — เซิร์ฟเวอร์คำนวณหัก ณ ที่จ่ายให้ แล้วอัปเดตบนการ์ด */
  const patchAmounts = (lineId: string, field: "amount" | "vatAmount" | "whtRate", raw: string) => {
    const v = parseAmountInput(raw);
    const cur = rows.find((r) => r.id === lineId);
    if (!cur || !Number.isFinite(v) || v < 0 || cur[field] === v) return;
    setRows((prev) => prev.map((r) => (r.id === lineId ? { ...r, [field]: v } : r)));
    startTransition(async () => {
      const r = await patchBillLineAmountsAction({
        customerId,
        entryId,
        lineId,
        [field === "amount" ? "amount" : field === "vatAmount" ? "vatAmount" : "whtRate"]: v,
      });
      if (!r.ok) {
        setMsg({ ok: false, text: r.message ?? "บันทึกยอดไม่สำเร็จ" });
        return;
      }
      if (typeof r.whtAmount === "number") {
        setRows((prev) => prev.map((x) => (x.id === lineId ? { ...x, whtAmount: r.whtAmount! } : x)));
      }
      router.refresh();
    });
  };

  return (
    <div className="wsp-quickfix wsp-ml" ref={rootRef}>
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

      <div className="wsp-mlbox">
        <table className="wsp-mltable">
          <thead>
            <tr>
              <th className="t-desc">รายการ ({rows.length})</th>
              <th className="t-acct">เลขผังบัญชี ({entryType === "sale" ? "เครดิต" : "เดบิต"})</th>
              <th>มูลค่า</th>
              <th>VAT</th>
              <th>หัก %</th>
              <th>หัก ณ ที่จ่าย</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="t-desc" title={r.description ?? ""}>{r.description || "—"}</td>
                <td className="t-acct wsp-ml-acct">
                  <AccountCombobox
                    accountCode={r.accountCode ?? ""}
                    accountName={r.accountName ?? ""}
                    chart={chart}
                    readOnly={busy}
                    onSelect={(code, name) => pickLineAccount(r.id, code, name)}
                    onNameChange={(n) => r.accountCode && pickLineAccount(r.id, r.accountCode, n)}
                    onClear={() =>
                      setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, accountCode: "", accountName: "" } : x)))
                    }
                  />
                </td>
                <td>
                  <input
                    className="wsp-ml-num"
                    defaultValue={formatMoney(r.amount)}
                    inputMode="decimal"
                    onBlur={(e) => patchAmounts(r.id, "amount", e.target.value)}
                    aria-label="มูลค่า"
                  />
                </td>
                <td>
                  <input
                    className="wsp-ml-num sm"
                    defaultValue={formatMoney(r.vatAmount)}
                    inputMode="decimal"
                    onBlur={(e) => patchAmounts(r.id, "vatAmount", e.target.value)}
                    aria-label="VAT"
                  />
                </td>
                <td>
                  <input
                    className="wsp-ml-num sm"
                    defaultValue={r.whtRate ? String(r.whtRate) : ""}
                    placeholder="—"
                    inputMode="decimal"
                    onBlur={(e) => patchAmounts(r.id, "whtRate", e.target.value)}
                    aria-label="อัตราหัก ณ ที่จ่าย %"
                  />
                </td>
                <td className="t-wht">{r.whtAmount ? formatMoney(r.whtAmount) : "0.00"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="t-desc">รวม</td>
              <td className="t-acct" />
              <td>{formatMoney(totals.amount)}</td>
              <td>{formatMoney(totals.vat)}</td>
              <td />
              <td className="t-wht">{formatMoney(totals.wht)}</td>
            </tr>
          </tfoot>
        </table>

        {/* ฝั่งเงิน (บัญชีคู่) — แถวเดียวท้ายกล่อง */}
        {known ? (
          <div className="wsp-ml-money">
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
        ) : null}
      </div>

      <span className="wsp-ml-hint">
        เลือกบัญชีแล้ว {doneCount}/{rows.length} · Tab = ช่องถัดไป · Enter ที่เลขผัง = บันทึก
        {doneCount < rows.length ? " (ครบทุกบรรทัด = ยืนยันอัตโนมัติ)" : ""}
      </span>
      {msg ? (
        <span style={{ fontSize: 11, color: msg.ok ? "#166534" : "#b91c1c", flexBasis: "100%" }}>
          {msg.ok ? "✓ " : "⚠ "}{msg.text}
        </span>
      ) : null}
    </div>
  );
}
