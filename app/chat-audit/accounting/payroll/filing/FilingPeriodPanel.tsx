"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markFilingAction, unmarkFilingAction } from "./actions";
import type { PayrollMonthlyFiling, FilingPeriodDetail } from "@/lib/accounting/payroll-monthly-filing";
import { formatMoney } from "@/lib/accounting/calc";

/**
 * FilingPeriodPanel — รายการหน่วยยื่นรายเดือน + รายละเอียด (ทุกรอบจ่ายที่รวมอยู่ในเดือนนั้น + ยอดรวม
 *   PIT/SSO ข้ามรอบ + ปุ่มยื่นแล้ว 1 ชุด/เดือน) — เฟส 9b กลุ่ม BC (T139)
 *
 * ★ สำหรับลูกค้า pay_frequency='monthly' เดือนหนึ่งมีแค่ 1 รอบเสมอ — หน้านี้ทำงานเหมือนหน้ารอบเงินเดือนเดิม
 *   ทุกประการจากมุมมอง UX (1 รอบ = 1 เดือนเป๊ะ, T141)
 * ★ ปุ่มยื่นแล้วเปิดใช้เฉพาะเมื่อมีอย่างน้อย 1 รอบ status='finalized' ผูกอยู่ (guard ที่ server, T137) —
 *   ฝั่ง client แค่ปิดปุ่มไว้ล่วงหน้าเป็น UX ช่วย ไม่ใช่การบังคับจริง (บังคับจริงที่ server เท่านั้น)
 */

const MONTH_LABELS = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

export default function FilingPeriodPanel({
  customerId,
  periods,
  detail,
}: {
  customerId: string;
  periods: PayrollMonthlyFiling[];
  detail: FilingPeriodDetail | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const openPeriod = (id: string) => {
    router.push(`/chat-audit/accounting/payroll/filing?customerId=${customerId}&periodId=${id}`);
  };

  const hasFinalizedRun = detail ? detail.runs.some((r) => r.status === "finalized") : false;

  const toggleFiled = (kind: "pit" | "sso", filed: boolean) => {
    if (!detail) return;
    setMsg(null);
    startTransition(async () => {
      const res = filed
        ? await unmarkFilingAction(detail.period.id, customerId, kind)
        : await markFilingAction(detail.period.id, customerId, kind);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  };

  const totals = detail
    ? detail.runs.reduce(
        (acc, r) => ({
          pit: acc.pit + r.totalPit,
          ssoEmp: acc.ssoEmp + r.totalSsoEmployee,
          ssoEmpr: acc.ssoEmpr + r.totalSsoEmployer,
          net: acc.net + r.totalNetPay,
        }),
        { pit: 0, ssoEmp: 0, ssoEmpr: 0, net: 0 }
      )
    : null;

  return (
    <div>
      {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}

      {!detail ? (
        <div className="table-wrap">
          <table className="dlv-table acc-table">
            <thead>
              <tr>
                <th>เดือน/ปี</th>
                <th className="center">ยื่น ภ.ง.ด.1</th>
                <th className="center">ยื่น สปส.1-10</th>
                <th className="center">เปิด</th>
              </tr>
            </thead>
            <tbody>
              {periods.length === 0 ? (
                <tr><td colSpan={4}><p className="empty">ยังไม่มีหน่วยยื่นรายเดือนของลูกค้ารายนี้ (สร้างรอบเงินเดือนก่อน)</p></td></tr>
              ) : (
                periods.map((p) => (
                  <tr key={p.id}>
                    <td>{MONTH_LABELS[p.periodMonth]} {p.periodYear}</td>
                    <td className="center">{p.pitFilingStatus === "filed" ? "ยื่นแล้ว" : "—"}</td>
                    <td className="center">{p.ssoFilingStatus === "filed" ? "ยื่นแล้ว" : "—"}</td>
                    <td className="center">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => openPeriod(p.id)}>เปิด</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="acc-review-head" style={{ marginBottom: 10 }}>
            <button type="button" className="btn btn-ghost" onClick={() => router.push(`/chat-audit/accounting/payroll/filing?customerId=${customerId}`)}>
              ← กลับรายการเดือน
            </button>
            <span className="acc-toolbar-spacer" />
            <span className="muted">
              เดือน {MONTH_LABELS[detail.period.periodMonth]} {detail.period.periodYear} · {detail.runs.length} รอบจ่าย
            </span>
          </div>

          <div className="card" style={{ marginBottom: 10 }}>
            <div className="section-title"><span>สถานะยื่นภาษี/ประกันสังคม (รวมทุกรอบจ่ายของเดือนนี้)</span></div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div>
                ภ.ง.ด.1: {detail.period.pitFilingStatus === "filed" ? `ยื่นแล้ว (${detail.period.pitFiledAt ?? ""})` : "ยังไม่ยื่น"}{" "}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={pending || (detail.period.pitFilingStatus !== "filed" && !hasFinalizedRun)}
                  onClick={() => toggleFiled("pit", detail.period.pitFilingStatus === "filed")}
                  title={!hasFinalizedRun && detail.period.pitFilingStatus !== "filed" ? "ต้องมีอย่างน้อย 1 รอบสร้างรายการบัญชี (JE) แล้วก่อน" : undefined}
                >
                  {detail.period.pitFilingStatus === "filed" ? "ยกเลิกสถานะ" : "บันทึกว่ายื่นแล้ว"}
                </button>{" "}
                {/* เอกสารสรุปยอดยื่น ภ.ง.ด.1 (Excel) — ไม่ใช่ e-filing จริง แค่เอกสารให้เอาไปกรอกเว็บสรรพากรเอง (wishlist ข้อ 5) */}
                <a
                  href={`/chat-audit/accounting/payroll/filing/pnd1-export?customerId=${customerId}&periodId=${detail.period.id}`}
                  className="btn btn-ghost btn-sm"
                >
                  ดาวน์โหลดสรุปยื่น ภ.ง.ด.1 (Excel)
                </a>
              </div>
              <div>
                สปส.1-10: {detail.period.ssoFilingStatus === "filed" ? `ยื่นแล้ว (${detail.period.ssoFiledAt ?? ""})` : "ยังไม่ยื่น"}{" "}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={pending || (detail.period.ssoFilingStatus !== "filed" && !hasFinalizedRun)}
                  onClick={() => toggleFiled("sso", detail.period.ssoFilingStatus === "filed")}
                  title={!hasFinalizedRun && detail.period.ssoFilingStatus !== "filed" ? "ต้องมีอย่างน้อย 1 รอบสร้างรายการบัญชี (JE) แล้วก่อน" : undefined}
                >
                  {detail.period.ssoFilingStatus === "filed" ? "ยกเลิกสถานะ" : "บันทึกว่ายื่นแล้ว"}
                </button>
              </div>
            </div>
          </div>

          <div className="table-wrap">
            <table className="dlv-table acc-table">
              <thead>
                <tr>
                  <th>วันที่จ่าย</th>
                  <th className="center">สถานะ</th>
                  <th className="num">ภาษีหัก ณ ที่จ่าย</th>
                  <th className="num">ประกันสังคม (ลูกจ้าง)</th>
                  <th className="num">ประกันสังคม (นายจ้าง)</th>
                  <th className="num">เงินเดือนสุทธิ</th>
                </tr>
              </thead>
              <tbody>
                {detail.runs.length === 0 ? (
                  <tr><td colSpan={6}><p className="empty">เดือนนี้ยังไม่มีรอบจ่ายเลย</p></td></tr>
                ) : (
                  detail.runs.map((r) => (
                    <tr key={r.id}>
                      <td>{r.payDate}</td>
                      <td className="center">
                        <span className={`st-badge ${r.status === "finalized" ? "st-confirmed" : "st-draft"}`}>
                          {r.status === "finalized" ? "สร้าง JE แล้ว" : "ร่าง"}
                        </span>
                      </td>
                      <td className="num">{formatMoney(r.totalPit)}</td>
                      <td className="num">{formatMoney(r.totalSsoEmployee)}</td>
                      <td className="num">{formatMoney(r.totalSsoEmployer)}</td>
                      <td className="num strong">{formatMoney(r.totalNetPay)}</td>
                    </tr>
                  ))
                )}
                {totals ? (
                  <tr className="acc-total">
                    <td className="strong">รวมทั้งสิ้น</td>
                    <td />
                    <td className="num strong">{formatMoney(totals.pit)}</td>
                    <td className="num strong">{formatMoney(totals.ssoEmp)}</td>
                    <td className="num strong">{formatMoney(totals.ssoEmpr)}</td>
                    <td className="num strong">{formatMoney(totals.net)}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
