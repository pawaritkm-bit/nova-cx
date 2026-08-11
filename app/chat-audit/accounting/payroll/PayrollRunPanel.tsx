"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createRunAction,
  recalcRunAction,
  generateJournalEntryAction,
  deleteRunAction,
  markFiledAction,
  unmarkFiledAction,
} from "./actions";
import type { PayrollRun, PayrollRunLine } from "@/lib/accounting/payroll";
import { parseAmountInput, formatMoney } from "@/lib/accounting/calc";
import SlipView from "./SlipView";

/**
 * PayrollRunPanel — รายการรอบเงินเดือน + สร้างรอบใหม่ + ตารางบรรทัดต่อพนักงานของรอบที่เลือก (เฟส 9 ส่วน AD/AE)
 *
 * ★ 0.5 ช่องกรอกโบนัสเปิดใช้งานแล้ว (verify สูตรภาษีโบนัสตามคำสั่งกรมสรรพากรที่ ป.96/2543 ข้อ 1(5) เสร็จแล้ว,
 *   T112) — ดูคอมเมนต์เต็มใน lib/accounting/payroll-tax.ts (calcMonthlyPitWithBonus)
 * ★ 0.7/0.9 ปุ่ม "สร้างรายการบัญชี (JE)" สร้าง draft เสมอ + กันกดซ้ำสอง (server-side atomic claim)
 * ★ ล็อกแก้ไขยอด/คำนวณซ้ำหลังรอบ status='finalized' (มี JE แล้ว)
 */

const MONTH_LABELS = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function currentBuddhistYear(): number {
  return new Date().getFullYear() + 543;
}

type LineEditState = { grossSalary: string; otherAdditions: string; bonusAmount: string; otherDeductions: string };

export default function PayrollRunPanel({
  customerId,
  runs,
  detail,
}: {
  customerId: string;
  runs: PayrollRun[];
  detail: { run: PayrollRun; lines: PayrollRunLine[] } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [newYear, setNewYear] = useState(String(currentBuddhistYear()));
  const [newMonth, setNewMonth] = useState(String(new Date().getMonth() + 1));
  const [newPayDate, setNewPayDate] = useState(todayIso());

  const createRun = () => {
    setMsg(null);
    startTransition(async () => {
      const res = await createRunAction(customerId, {
        payPeriodYear: Number(newYear),
        payPeriodMonth: Number(newMonth),
        payDate: newPayDate,
      });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok && res.id) {
        router.push(`/chat-audit/accounting/payroll?customerId=${customerId}&runId=${res.id}`);
      }
    });
  };

  const openRun = (id: string) => {
    router.push(`/chat-audit/accounting/payroll?customerId=${customerId}&runId=${id}`);
  };

  const [edits, setEdits] = useState<Record<string, LineEditState>>({});
  const [slipLine, setSlipLine] = useState<PayrollRunLine | null>(null);

  const isDraft = detail?.run.status === "draft";
  const isFinalized = detail?.run.status === "finalized";

  const getEdit = (l: PayrollRunLine): LineEditState =>
    edits[l.id] ?? {
      grossSalary: String(l.grossSalary),
      otherAdditions: String(l.otherAdditions),
      bonusAmount: String(l.bonusAmount),
      otherDeductions: String(l.otherDeductions),
    };

  // ★ ต้องรับ line เดิม (ไม่ใช่แค่ id) — ตอนแก้ฟิลด์ใดฟิลด์หนึ่งเป็นครั้งแรกของแถวนี้ (m[id] ยังไม่มี)
  //   ต้อง seed ค่าฐานจากข้อมูลจริงของแถว (getEdit(l)) ไม่ใช่ค่าว่างเปล่า มิฉะนั้นฟิลด์อื่นที่ยังไม่ได้แตะ
  //   จะถูกส่งเป็น 0 ตอนคำนวณ (เช่น กรอกโบนัสอย่างเดียว เงินเดือนที่ prefill ไว้จะหายไปเป็น 0)
  const setEdit = (l: PayrollRunLine, patch: Partial<LineEditState>) => {
    setEdits((m) => ({
      ...m,
      [l.id]: { ...(m[l.id] ?? getEdit(l)), ...patch },
    }));
  };

  const totals = useMemo(() => {
    if (!detail) return null;
    let gross = 0, additions = 0, bonus = 0, deductions = 0, pit = 0, ssoEmp = 0, ssoEmpr = 0, net = 0;
    for (const l of detail.lines) {
      gross += l.grossSalary;
      additions += l.otherAdditions;
      bonus += l.bonusAmount;
      deductions += l.otherDeductions;
      pit += l.pitWithheld;
      ssoEmp += l.ssoEmployee;
      ssoEmpr += l.ssoEmployer;
      net += l.netPay;
    }
    return { gross, additions, bonus, deductions, pit, ssoEmp, ssoEmpr, net };
  }, [detail]);

  const recalc = () => {
    if (!detail) return;
    setMsg(null);
    const lineEdits = detail.lines.map((l) => {
      const e = getEdit(l);
      return {
        id: l.id,
        grossSalary: parseAmountInput(e.grossSalary),
        otherAdditions: parseAmountInput(e.otherAdditions),
        bonusAmount: parseAmountInput(e.bonusAmount),
        otherDeductions: parseAmountInput(e.otherDeductions),
      };
    });
    startTransition(async () => {
      const res = await recalcRunAction(detail.run.id, customerId, lineEdits);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  };

  const generateJe = () => {
    if (!detail) return;
    if (!confirm("ยืนยันสร้างรายการบัญชี (JE) ของรอบนี้? หลังสร้างแล้วจะแก้ไขยอดในรอบนี้ไม่ได้อีก")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await generateJournalEntryAction(detail.run.id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok || res.existingManualEntryId) router.refresh();
    });
  };

  const deleteRun = () => {
    if (!detail) return;
    if (!confirm("ยืนยันลบรอบเงินเดือนนี้?")) return;
    setMsg(null);
    startTransition(async () => {
      const res = await deleteRunAction(detail.run.id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.push(`/chat-audit/accounting/payroll?customerId=${customerId}`);
    });
  };

  const toggleFiled = (kind: "pit" | "sso", filed: boolean) => {
    if (!detail) return;
    setMsg(null);
    startTransition(async () => {
      const res = filed
        ? await unmarkFiledAction(detail.run.id, customerId, kind)
        : await markFiledAction(detail.run.id, customerId, kind);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  };

  return (
    <div>
      {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}

      {!detail ? (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="section-title"><span>สร้างรอบเงินเดือนใหม่</span></div>
            <div className="acc-field-grid">
              <label className="acc-field">
                <span>ปี (พ.ศ.)</span>
                <input value={newYear} onChange={(e) => setNewYear(e.target.value)} inputMode="numeric" />
              </label>
              <label className="acc-field">
                <span>เดือน</span>
                <select value={newMonth} onChange={(e) => setNewMonth(e.target.value)}>
                  {MONTH_LABELS.slice(1).map((label, i) => (
                    <option key={i + 1} value={i + 1}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="acc-field">
                <span>วันที่จ่ายจริง</span>
                <input type="date" value={newPayDate} onChange={(e) => setNewPayDate(e.target.value)} />
              </label>
            </div>
            <div style={{ marginTop: 10 }}>
              <button type="button" className="btn" disabled={pending} onClick={createRun}>สร้างรอบใหม่</button>
            </div>
          </div>

          <div className="table-wrap">
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>งวด</th>
                  <th>วันที่จ่าย</th>
                  <th className="center">สถานะ</th>
                  <th className="center">ยื่น ภ.ง.ด.1</th>
                  <th className="center">ยื่น สปส.1-10</th>
                  <th className="center">เปิด</th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 ? (
                  <tr><td colSpan={6}><p className="empty">ยังไม่มีรอบเงินเดือนของลูกค้ารายนี้</p></td></tr>
                ) : (
                  runs.map((r) => (
                    <tr key={r.id}>
                      <td>{MONTH_LABELS[r.payPeriodMonth]} {r.payPeriodYear}</td>
                      <td>{r.payDate}</td>
                      <td className="center">
                        <span className={`st-badge ${r.status === "finalized" ? "st-confirmed" : "st-draft"}`}>
                          {r.status === "finalized" ? "สร้าง JE แล้ว" : "ร่าง"}
                        </span>
                      </td>
                      <td className="center">{r.pitFilingStatus === "filed" ? "ยื่นแล้ว" : "—"}</td>
                      <td className="center">{r.ssoFilingStatus === "filed" ? "ยื่นแล้ว" : "—"}</td>
                      <td className="center">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openRun(r.id)}>เปิด</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className="acc-review-head" style={{ marginBottom: 10 }}>
            <button type="button" className="btn btn-ghost" onClick={() => router.push(`/chat-audit/accounting/payroll?customerId=${customerId}`)}>
              ← กลับรายการรอบ
            </button>
            <span className="acc-toolbar-spacer" />
            <span className="muted">
              งวด {MONTH_LABELS[detail.run.payPeriodMonth]} {detail.run.payPeriodYear} · จ่าย {detail.run.payDate} ·{" "}
              {detail.run.status === "finalized" ? "สร้าง JE แล้ว (ล็อกแก้ไข)" : "ร่าง (แก้ไขได้)"}
            </span>
            <a href={`/chat-audit/accounting/payroll/export?runId=${detail.run.id}&customerId=${customerId}`} className="btn btn-ghost">
              ออก Excel
            </a>
            {isDraft ? (
              <>
                <button type="button" className="btn" disabled={pending} onClick={recalc}>คำนวณภาษี+ประกันสังคม</button>
                <button type="button" className="btn" disabled={pending} onClick={generateJe}>สร้างรายการบัญชี (JE)</button>
                <button type="button" className="btn btn-ghost" disabled={pending} onClick={deleteRun}>ลบรอบนี้</button>
              </>
            ) : null}
          </div>

          {isFinalized ? (
            <div className="card" style={{ marginBottom: 10 }}>
              <div className="section-title"><span>สถานะยื่นภาษี/ประกันสังคม</span></div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <div>
                  ภ.ง.ด.1: {detail.run.pitFilingStatus === "filed" ? `ยื่นแล้ว (${detail.run.pitFiledAt ?? ""})` : "ยังไม่ยื่น"}{" "}
                  <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => toggleFiled("pit", detail.run.pitFilingStatus === "filed")}>
                    {detail.run.pitFilingStatus === "filed" ? "ยกเลิกสถานะ" : "บันทึกว่ายื่นแล้ว"}
                  </button>
                </div>
                <div>
                  สปส.1-10: {detail.run.ssoFilingStatus === "filed" ? `ยื่นแล้ว (${detail.run.ssoFiledAt ?? ""})` : "ยังไม่ยื่น"}{" "}
                  <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => toggleFiled("sso", detail.run.ssoFilingStatus === "filed")}>
                    {detail.run.ssoFilingStatus === "filed" ? "ยกเลิกสถานะ" : "บันทึกว่ายื่นแล้ว"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="table-wrap">
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>พนักงาน</th>
                  <th className="num">เงินเดือน/ค่าจ้าง</th>
                  <th className="num">รายรับเพิ่มเติม</th>
                  <th className="num" title="โบนัส/เงินได้ครั้งเดียว — ภาษีคำนวณตามคำสั่งกรมสรรพากรที่ ป.96/2543 ข้อ 1(5) หักเต็มจำนวนในงวดที่จ่ายจริง">โบนัส</th>
                  <th className="num">หักอื่น ๆ</th>
                  <th className="num">ภาษีหัก ณ ที่จ่าย</th>
                  <th className="num">ประกันสังคม (ลูกจ้าง)</th>
                  <th className="num">ประกันสังคม (นายจ้าง)</th>
                  <th className="num">เงินเดือนสุทธิ</th>
                  <th className="center">สลิป</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => {
                  const e = getEdit(l);
                  return (
                    <tr key={l.id}>
                      <td>{l.employeeFullName}{l.employeeCode ? ` (${l.employeeCode})` : ""}</td>
                      <td className="num">
                        <input
                          className="num"
                          inputMode="decimal"
                          style={{ width: 100 }}
                          disabled={!isDraft}
                          value={e.grossSalary}
                          onChange={(ev) => setEdit(l, { grossSalary: ev.target.value })}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="num"
                          inputMode="decimal"
                          style={{ width: 90 }}
                          disabled={!isDraft}
                          value={e.otherAdditions}
                          onChange={(ev) => setEdit(l, { otherAdditions: ev.target.value })}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="num"
                          inputMode="decimal"
                          style={{ width: 90 }}
                          disabled={!isDraft}
                          value={e.bonusAmount}
                          onChange={(ev) => setEdit(l, { bonusAmount: ev.target.value })}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="num"
                          inputMode="decimal"
                          style={{ width: 90 }}
                          disabled={!isDraft}
                          value={e.otherDeductions}
                          onChange={(ev) => setEdit(l, { otherDeductions: ev.target.value })}
                        />
                      </td>
                      <td className="num">{formatMoney(l.pitWithheld)}</td>
                      <td className="num">{formatMoney(l.ssoEmployee)}</td>
                      <td className="num">{formatMoney(l.ssoEmployer)}</td>
                      <td className="num strong">{formatMoney(l.netPay)}</td>
                      <td className="center">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSlipLine(l)}>สลิป</button>
                      </td>
                    </tr>
                  );
                })}
                {totals ? (
                  <tr className="acc-total">
                    <td className="strong">รวมทั้งสิ้น</td>
                    <td className="num strong">{formatMoney(totals.gross)}</td>
                    <td className="num strong">{formatMoney(totals.additions)}</td>
                    <td className="num strong">{formatMoney(totals.bonus)}</td>
                    <td className="num strong">{formatMoney(totals.deductions)}</td>
                    <td className="num strong">{formatMoney(totals.pit)}</td>
                    <td className="num strong">{formatMoney(totals.ssoEmp)}</td>
                    <td className="num strong">{formatMoney(totals.ssoEmpr)}</td>
                    <td className="num strong">{formatMoney(totals.net)}</td>
                    <td />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}

      {slipLine ? (
        <SlipView
          line={slipLine}
          run={detail!.run}
          onClose={() => setSlipLine(null)}
        />
      ) : null}
    </div>
  );
}
