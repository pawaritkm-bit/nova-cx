"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upsertFundAction, createVoucherAction, deleteVoucherAction, settleVouchersAction } from "./actions";
import { computeBalance, type PettyCashFund, type PettyCashVoucher } from "@/lib/accounting/petty-cash";
import type { ChartAccount } from "@/lib/accounting/chart-of-accounts";
import AccountCombobox from "../AccountCombobox";

/** format ตัวเลขเป็นเงินไทย (ทศนิยม 2) */
function money(n: number): string {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateThai(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : "—";
}

function accountNameFor(code: string, chart: ChartAccount[]): string {
  return chart.find((a) => a.code === code)?.name ?? "";
}

/**
 * PettyCashPanel — ตั้งกองทุนเงินสดย่อยคงที่ (imprest) + บันทึกใบเบิก + เคลียร์รวมเป็นดราฟต์ JE (wishlist ข้อ 3)
 *   ★ เคลียร์เงินสดย่อยสร้าง manual JE เป็น "ดราฟต์" เสมอ ไม่เคย auto-ยืนยัน — นักบัญชีต้องไปตรวจสอบ/
 *   ยืนยันเองที่หน้า "ลงบันทึกบัญชีเอง" ก่อนจึงมีผลกับยอดบัญชีจริง (mirror PlatformReportAnalyzer.tsx)
 */
export default function PettyCashPanel({
  customerId,
  fund,
  vouchers,
  chart,
}: {
  customerId: string;
  fund: PettyCashFund;
  vouchers: PettyCashVoucher[];
  chart: ChartAccount[];
}) {
  const router = useRouter();

  // ตั้งค่ากองทุน
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPending, startSettingsTransition] = useTransition();
  const [settingsMsg, setSettingsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [fundNameForm, setFundNameForm] = useState(fund.fundName);
  const [floatAmountForm, setFloatAmountForm] = useState(String(fund.floatAmount));
  const [cashCodeForm, setCashCodeForm] = useState(fund.cashAccountCode);
  const [cashNameForm, setCashNameForm] = useState(() => accountNameFor(fund.cashAccountCode, chart));
  const [sourceCodeForm, setSourceCodeForm] = useState(fund.sourceAccountCode);
  const [sourceNameForm, setSourceNameForm] = useState(() => accountNameFor(fund.sourceAccountCode, chart));

  function saveSettings() {
    setSettingsMsg(null);
    startSettingsTransition(async () => {
      const res = await upsertFundAction({
        customerId,
        fundName: fundNameForm,
        floatAmount: floatAmountForm,
        cashAccountCode: cashCodeForm,
        sourceAccountCode: sourceCodeForm,
      });
      setSettingsMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  // เพิ่มใบเบิก
  const [voucherPending, startVoucherTransition] = useTransition();
  const [voucherMsg, setVoucherMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [voucherDate, setVoucherDate] = useState(todayIso());
  const [voucherDescription, setVoucherDescription] = useState("");
  const [voucherCategoryCode, setVoucherCategoryCode] = useState("");
  const [voucherCategoryName, setVoucherCategoryName] = useState("");
  const [voucherAmount, setVoucherAmount] = useState("");
  const [voucherReceiptNo, setVoucherReceiptNo] = useState("");

  function addVoucher() {
    setVoucherMsg(null);
    startVoucherTransition(async () => {
      const res = await createVoucherAction({
        customerId,
        fundId: fund.id,
        voucherDate,
        description: voucherDescription || undefined,
        categoryAccountCode: voucherCategoryCode,
        amount: voucherAmount,
        receiptNo: voucherReceiptNo || undefined,
      });
      setVoucherMsg({ ok: res.ok, text: res.ok ? "เพิ่มใบเบิกแล้ว" : res.message });
      if (res.ok) {
        setVoucherDescription("");
        setVoucherCategoryCode("");
        setVoucherCategoryName("");
        setVoucherAmount("");
        setVoucherReceiptNo("");
        router.refresh();
      }
    });
  }

  function removeVoucher(id: string) {
    startVoucherTransition(async () => {
      const res = await deleteVoucherAction(id, customerId);
      setVoucherMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  // เคลียร์เงินสดย่อย (settle)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [settleDate, setSettleDate] = useState(todayIso());
  const [settlePending, startSettleTransition] = useTransition();
  const [settleMsg, setSettleMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function settle() {
    if (selectedIds.size === 0) {
      setSettleMsg({ ok: false, text: "กรุณาเลือกใบเบิกอย่างน้อย 1 ใบ" });
      return;
    }
    setSettleMsg(null);
    startSettleTransition(async () => {
      const res = await settleVouchersAction({
        customerId,
        fundId: fund.id,
        voucherIds: [...selectedIds],
        docDate: settleDate,
      });
      setSettleMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setSelectedIds(new Set());
        router.refresh();
      }
    });
  }

  const pendingVouchers = useMemo(() => vouchers.filter((v) => v.status === "pending"), [vouchers]);
  const settledVouchers = useMemo(() => vouchers.filter((v) => v.status === "settled"), [vouchers]);
  const balance = useMemo(() => computeBalance(fund, pendingVouchers), [fund, pendingVouchers]);
  const selectedTotal = useMemo(
    () => pendingVouchers.filter((v) => selectedIds.has(v.id)).reduce((s, v) => s + v.amount, 0),
    [pendingVouchers, selectedIds]
  );

  return (
    <div>
      <div
        className="card"
        style={{ marginBottom: 14, maxWidth: 320, background: "#fafafa", border: "1px solid #e6e6e6" }}
      >
        <div className="section-title"><span>{fund.fundName}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.92rem", padding: "2px 0" }}>
          <span>ยอดคงที่ (float)</span>
          <b>{money(fund.floatAmount)}</b>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.92rem", padding: "2px 0", color: "#b02a37" }}>
          <span>เบิกไปแล้ว (ยัง pending)</span>
          <b>{money(fund.floatAmount - balance)}</b>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: "1px dashed #ddd",
            marginTop: 6,
            paddingTop: 6,
            fontSize: "0.95rem",
          }}
        >
          <span>คงเหลือ</span>
          <b>{money(balance)}</b>
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <button type="button" className="btn btn-ghost" onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? "ปิดตั้งค่ากองทุน" : "⚙ ตั้งค่ากองทุน"}
        </button>
      </div>

      {showSettings ? (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="section-title"><span>ตั้งค่ากองทุนเงินสดย่อย</span></div>
          <div className="acc-field-grid">
            <label className="acc-field">
              <span>ชื่อกองทุน</span>
              <input value={fundNameForm} onChange={(e) => setFundNameForm(e.target.value)} />
            </label>
            <label className="acc-field">
              <span>ยอดคงที่ (float amount)</span>
              <input className="num" inputMode="decimal" value={floatAmountForm} onChange={(e) => setFloatAmountForm(e.target.value)} />
            </label>
            <label className="acc-field">
              <span>บัญชีเงินสดย่อย (สินทรัพย์)</span>
              <AccountCombobox
                accountCode={cashCodeForm}
                accountName={cashNameForm}
                chart={chart}
                readOnly={false}
                onSelect={(code, name) => {
                  setCashCodeForm(code);
                  setCashNameForm(name);
                }}
                onNameChange={setCashNameForm}
                onClear={() => {
                  setCashCodeForm("");
                  setCashNameForm("");
                }}
              />
            </label>
            <label className="acc-field">
              <span>บัญชีต้นทางที่เติมเงินคืน (สินทรัพย์)</span>
              <AccountCombobox
                accountCode={sourceCodeForm}
                accountName={sourceNameForm}
                chart={chart}
                readOnly={false}
                onSelect={(code, name) => {
                  setSourceCodeForm(code);
                  setSourceNameForm(name);
                }}
                onNameChange={setSourceNameForm}
                onClear={() => {
                  setSourceCodeForm("");
                  setSourceNameForm("");
                }}
              />
            </label>
          </div>
          <button type="button" className="btn" onClick={saveSettings} disabled={settingsPending} style={{ marginTop: 10 }}>
            {settingsPending ? "กำลังบันทึก…" : "บันทึกตั้งค่า"}
          </button>
          {settingsMsg ? <div className={`action-msg ${settingsMsg.ok ? "ok" : "err"}`}>{settingsMsg.text}</div> : null}
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title"><span>เพิ่มใบเบิก</span></div>
        <div className="acc-field-grid">
          <label className="acc-field">
            <span>วันที่ใบเบิก</span>
            <input type="date" value={voucherDate} onChange={(e) => setVoucherDate(e.target.value)} />
          </label>
          <label className="acc-field">
            <span>รายละเอียด</span>
            <input value={voucherDescription} onChange={(e) => setVoucherDescription(e.target.value)} />
          </label>
          <label className="acc-field">
            <span>บัญชีค่าใช้จ่าย</span>
            <AccountCombobox
              accountCode={voucherCategoryCode}
              accountName={voucherCategoryName}
              chart={chart}
              readOnly={false}
              onSelect={(code, name) => {
                setVoucherCategoryCode(code);
                setVoucherCategoryName(name);
              }}
              onNameChange={setVoucherCategoryName}
              onClear={() => {
                setVoucherCategoryCode("");
                setVoucherCategoryName("");
              }}
            />
          </label>
          <label className="acc-field">
            <span>จำนวนเงิน (บาท) *</span>
            <input className="num" inputMode="decimal" value={voucherAmount} onChange={(e) => setVoucherAmount(e.target.value)} />
          </label>
          <label className="acc-field">
            <span>เลขที่ใบเสร็จ (ถ้ามี)</span>
            <input value={voucherReceiptNo} onChange={(e) => setVoucherReceiptNo(e.target.value)} />
          </label>
        </div>
        <button type="button" className="btn" onClick={addVoucher} disabled={voucherPending} style={{ marginTop: 10 }}>
          {voucherPending ? "กำลังบันทึก…" : "เพิ่มใบเบิก"}
        </button>
        {voucherMsg ? <div className={`action-msg ${voucherMsg.ok ? "ok" : "err"}`}>{voucherMsg.text}</div> : null}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">
          <span>ใบเบิกที่ยัง pending ({pendingVouchers.length}) — เลือกแล้วกด &quot;เคลียร์เงินสดย่อย&quot;</span>
        </div>
        {pendingVouchers.length === 0 ? (
          <p className="empty">ไม่มีใบเบิกที่ยัง pending</p>
        ) : (
          <>
            <div className="table-wrap" style={{ marginBottom: 10 }}>
              <table className="dlv-table acc-table">
                <thead>
                  <tr>
                    <th className="center">เลือก</th>
                    <th>วันที่</th>
                    <th>รายละเอียด</th>
                    <th>บัญชี</th>
                    <th className="num">จำนวนเงิน</th>
                    <th>เลขที่ใบเสร็จ</th>
                    <th className="center">จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingVouchers.map((v) => (
                    <tr key={v.id}>
                      <td className="center">
                        <input type="checkbox" checked={selectedIds.has(v.id)} onChange={() => toggleSelected(v.id)} />
                      </td>
                      <td>{formatDateThai(v.voucherDate)}</td>
                      <td>{v.description || "—"}</td>
                      <td>
                        {v.categoryAccountCode} {v.categoryAccountName ? `· ${v.categoryAccountName}` : ""}
                      </td>
                      <td className="num">{money(v.amount)}</td>
                      <td>{v.receiptNo || "—"}</td>
                      <td className="center">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeVoucher(v.id)} disabled={voucherPending}>
                          ลบ
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <label className="acc-field" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span>วันที่เอกสาร JE</span>
                <input type="date" value={settleDate} onChange={(e) => setSettleDate(e.target.value)} />
              </label>
              <span>เลือกไว้ {selectedIds.size} ใบ รวม {money(selectedTotal)} บาท</span>
              <button type="button" className="btn" onClick={settle} disabled={settlePending || selectedIds.size === 0}>
                {settlePending ? "กำลังเคลียร์…" : "เคลียร์เงินสดย่อย (สร้างดราฟต์ JE)"}
              </button>
            </div>
            <p className="empty" style={{ marginTop: 6 }}>
              สร้างเป็น &quot;ดราฟต์&quot; เสมอ — ไม่ auto-ยืนยัน ต้องไปตรวจสอบ/ยืนยันเองที่หน้า &quot;ลงบันทึกบัญชีเอง&quot; ก่อนจึงจะมีผลกับยอดบัญชีจริง
            </p>
            {settleMsg ? <div className={`action-msg ${settleMsg.ok ? "ok" : "err"}`}>{settleMsg.text}</div> : null}
          </>
        )}
      </div>

      {settledVouchers.length > 0 ? (
        <div className="card">
          <div className="section-title"><span>ประวัติที่เคลียร์แล้ว ({settledVouchers.length})</span></div>
          <div className="table-wrap">
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>รายละเอียด</th>
                  <th>บัญชี</th>
                  <th className="num">จำนวนเงิน</th>
                  <th>เคลียร์เมื่อ</th>
                </tr>
              </thead>
              <tbody>
                {settledVouchers.map((v) => (
                  <tr key={v.id}>
                    <td>{formatDateThai(v.voucherDate)}</td>
                    <td>{v.description || "—"}</td>
                    <td>
                      {v.categoryAccountCode} {v.categoryAccountName ? `· ${v.categoryAccountName}` : ""}
                    </td>
                    <td className="num">{money(v.amount)}</td>
                    <td>{v.settledAt ? formatDateThai(v.settledAt.slice(0, 10)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
