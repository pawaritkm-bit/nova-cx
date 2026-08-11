"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createFxRevaluationDraftAction,
  confirmFxRevaluationAction,
  confirmFxReversingAction,
  unconfirmFxReversingAction,
  fetchBotRateAction,
} from "./actions";
import type { FxOutstandingGroup, FxPeriodRevaluationWithLiveStatus, FxPeriodRevaluationStatus } from "@/lib/accounting/fx-revaluation";
import { formatMoney } from "@/lib/accounting/calc";

/**
 * FxRevaluationPanel — ปรับปรุงอัตราแลกเปลี่ยนปลายงวด ของลูกค้า 1 ราย (เฟส 10b)
 *   - รายการยอดคงค้าง FX แยกตาม currency/entryType (ก่อน VAT) + breakdown รายบิล (หมวด 5 ของแผน — ต้องโชว์
 *     ที่มาก่อนยืนยันเสมอ ไม่ post แบบเชื่อยอดรวมเฉย ๆ)
 *   - ฟอร์มสร้าง JV ปรับปรุง (period_end_date + closing_rate, ปุ่มดึงอัตรา ธปท. best-effort) — disable +
 *     ข้อความชัดเจนถ้ากลุ่มนั้นมีงวดก่อนหน้าที่ยัง reversing ไม่ confirm (client hint ของ guard #1 — server
 *     ยังบังคับจริงอีกชั้นเสมอ)
 *   - ประวัติ JV ปรับปรุง/กลับรายการ พร้อมปุ่มยืนยันแยกกัน (live status จาก server เท่านั้น ไม่ใช่ cache)
 *
 * ★ ทุกการเขียนผ่าน server action (guard requireAccountingAccess + assertCustomerInScope + service-role)
 */

const STATUS_LABEL: Record<FxPeriodRevaluationStatus, string> = {
  reval_draft: "รอยืนยัน JV ปรับปรุง",
  reversing_draft: "รอยืนยันรายการกลับรายการ",
  reversing_confirmed: "เสร็จสมบูรณ์",
  voided: "ยกเลิกแล้ว (JV เดิมถูกลบ)",
};

const ENTRY_TYPE_LABEL: Record<string, string> = { sale: "ขาย (AR)", purchase: "ซื้อ (AP)" };

function formatDateThai(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso ?? "";
}

function groupKey(currency: string, entryType: string): string {
  return `${currency}|${entryType}`;
}

export default function FxRevaluationPanel({
  customerId,
  groups,
  history,
  asOfDate,
}: {
  customerId: string;
  groups: FxOutstandingGroup[];
  history: FxPeriodRevaluationWithLiveStatus[];
  asOfDate: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // งวดก่อนหน้าล่าสุดที่ยัง live-active (ไม่ voided) ต่อกลุ่ม — client hint ของ guard #1 (0.10)
  const latestActiveByGroup = useMemo(() => {
    const map = new Map<string, FxPeriodRevaluationWithLiveStatus>();
    for (const row of history) {
      if (row.liveStatus === "voided") continue;
      const key = groupKey(row.currency, row.entryType);
      const cur = map.get(key);
      if (!cur || row.periodEndDate > cur.periodEndDate) map.set(key, row);
    }
    return map;
  }, [history]);

  const [formByGroup, setFormByGroup] = useState<Record<string, { periodEndDate: string; closingRate: string; source: "bot" | "manual" }>>(
    {}
  );
  const formFor = (key: string) => formByGroup[key] ?? { periodEndDate: asOfDate, closingRate: "", source: "manual" as const };
  const patchForm = (key: string, patch: Partial<{ periodEndDate: string; closingRate: string; source: "bot" | "manual" }>) => {
    setFormByGroup((prev) => ({ ...prev, [key]: { ...formFor(key), ...patch } }));
  };

  function onFetchBotRate(key: string, currency: string, periodEndDate: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await fetchBotRateAction(currency, periodEndDate);
      if (res.ok) {
        patchForm(key, { closingRate: String(res.rate), source: "bot" });
        setMsg({ ok: true, text: `ดึงอัตรา ธปท. สำเร็จ: ${res.rate}` });
      } else {
        setMsg({ ok: false, text: "ดึงอัตรา ธปท. ไม่สำเร็จ — กรอกอัตราปิดเองได้" });
      }
    });
  }

  function onCreate(g: FxOutstandingGroup) {
    const key = groupKey(g.currency, g.entryType);
    const form = formFor(key);
    const rate = Number(form.closingRate);
    if (!form.periodEndDate) {
      setMsg({ ok: false, text: "ต้องระบุวันที่สิ้นงวด" });
      return;
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      setMsg({ ok: false, text: "ต้องระบุอัตราปิดที่ถูกต้อง (มากกว่า 0)" });
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await createFxRevaluationDraftAction({
        customerId,
        entryType: g.entryType,
        currency: g.currency,
        periodEndDate: form.periodEndDate,
        closingRate: rate,
        source: form.source,
      });
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) {
        setFormByGroup((prev) => ({ ...prev, [key]: { periodEndDate: asOfDate, closingRate: "", source: "manual" } }));
        router.refresh();
      }
    });
  }

  function onConfirmRevaluation(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await confirmFxRevaluationAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  function onConfirmReversing(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await confirmFxReversingAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  /** 0.13 — ทางเข้าที่ถูกต้องทางเดียวสำหรับแก้ไข reversing_je_id ที่ยืนยันผิดพลาด (ปุ่มลบทั่วไปถูกบล็อกแล้ว
   *   ตอน cycle confirmed) — เตือนความเสี่ยง status drift ชัดเจนก่อนทำจริงเสมอ (หมวด 5 ของแผน) */
  function onUnconfirmReversing(id: string) {
    const confirmed = window.confirm(
      "ยกเลิกการยืนยันรายการกลับรายการ?\n\n" +
        "การยกเลิกนี้จะทำให้ยอด AR/AP ใน GL ไม่ตรงกับที่ระบบคำนวณไว้ ควรทำเฉพาะกรณีกดยืนยันผิดพลาดทันทีเท่านั้น " +
        "และต้องตรวจสอบว่ายังไม่มีการแนะนำ realized FX ของงวดใหม่ไปแล้วก่อนยกเลิก"
    );
    if (!confirmed) return;
    setMsg(null);
    startTransition(async () => {
      const res = await unconfirmFxReversingAction(id, customerId);
      setMsg({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="acc-je">
      {msg ? <div className={`action-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div> : null}

      {/* ---- ยอดคงค้าง FX แยกตาม currency/entryType ---- */}
      <div className="strong" style={{ marginBottom: 8 }}>
        ยอดคงค้างสกุลต่างประเทศ (ก่อน VAT) ณ วันที่ {formatDateThai(asOfDate)}
      </div>
      {groups.length === 0 ? (
        <p className="empty">ลูกค้ารายนี้ไม่มีบิลเชื่อสกุลต่างประเทศที่ยืนยันแล้วและยังค้างชำระ</p>
      ) : (
        groups.map((g) => {
          const key = groupKey(g.currency, g.entryType);
          const form = formFor(key);
          const latestActive = latestActiveByGroup.get(key);
          const blocked = !!latestActive && latestActive.liveStatus !== "reversing_confirmed";
          return (
            <div className="card" key={key} style={{ marginBottom: 12 }}>
              <div className="acc-je-form-head">
                <span className="strong">
                  {g.currency} — {ENTRY_TYPE_LABEL[g.entryType] ?? g.entryType}
                </span>
                <span className="muted">ยอดคงค้างรวม {formatMoney(g.outstandingFxAmount)} {g.currency}</span>
              </div>

              {/* breakdown รายบิล — ต้องเห็นที่มาก่อนยืนยันเสมอ (หมวด 5 ของแผน) */}
              {g.bills.length > 0 ? (
                <div className="table-wrap">
                  <table className="dlv-table acc-table">
                    <thead>
                      <tr>
                        <th>เลขที่บิล</th>
                        <th>วันที่</th>
                        <th>คู่ค้า</th>
                        <th className="num">อัตราตอนออกบิล</th>
                        <th className="num">ยอดคงค้าง ({g.currency})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.bills.map((b) => (
                        <tr key={b.entryId}>
                          <td>{b.docNo || "—"}</td>
                          <td>{b.docDate ? formatDateThai(b.docDate) : "—"}</td>
                          <td>{b.counterpartyName || "—"}</td>
                          <td className="num">{b.invoiceFxRate}</td>
                          <td className="num">{formatMoney(b.outstandingFxAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {blocked ? (
                <div className="action-msg err">
                  ต้องยืนยันรายการกลับรายการของงวดสิ้นสุด {formatDateThai(latestActive!.periodEndDate)} ให้เสร็จก่อน
                  จึงจะสร้างรายการปรับปรุงงวดใหม่ของกลุ่มนี้ได้ ({STATUS_LABEL[latestActive!.liveStatus]})
                </div>
              ) : null}

              <div className="acc-field-grid">
                <label className="acc-field">
                  <span>วันที่สิ้นงวด</span>
                  <input
                    type="date"
                    value={form.periodEndDate}
                    onChange={(e) => patchForm(key, { periodEndDate: e.target.value })}
                    disabled={pending || blocked}
                  />
                </label>
                <label className="acc-field">
                  <span>อัตราปิด ({g.currency} → บาท)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={form.closingRate}
                    onChange={(e) => patchForm(key, { closingRate: e.target.value, source: "manual" })}
                    placeholder="เช่น 33.50"
                    disabled={pending || blocked}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => onFetchBotRate(key, g.currency, form.periodEndDate)}
                  disabled={pending || blocked}
                >
                  ดึงอัตรา ธปท.
                </button>
                <button type="button" className="btn green" onClick={() => onCreate(g)} disabled={pending || blocked}>
                  สร้าง JV ปรับปรุง
                </button>
              </div>
            </div>
          );
        })
      )}

      {/* ---- ประวัติ JV ปรับปรุง/กลับรายการ ---- */}
      <div className="strong" style={{ marginTop: 20, marginBottom: 8 }}>
        ประวัติงวดที่ปรับปรุงแล้ว {history.length > 0 ? `(${history.length})` : ""}
      </div>
      {history.length === 0 ? (
        <p className="empty">ยังไม่มีประวัติการปรับปรุงอัตราแลกเปลี่ยนปลายงวด</p>
      ) : (
        <div className="table-wrap">
          <table className="dlv-table acc-table">
            <thead>
              <tr>
                <th>งวดสิ้นสุด</th>
                <th>สกุล/ฝั่ง</th>
                <th className="num">อัตราปิด</th>
                <th className="num">กำไร(ขาดทุน)ที่ยังไม่รับรู้</th>
                <th>สถานะ</th>
                <th>จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateThai(row.periodEndDate)}</td>
                  <td>
                    {row.currency} · {ENTRY_TYPE_LABEL[row.entryType] ?? row.entryType}
                  </td>
                  <td className="num">{row.closingRate}</td>
                  <td className="num">{formatMoney(row.unrealizedAmount)}</td>
                  <td>{STATUS_LABEL[row.liveStatus]}</td>
                  <td>
                    {row.liveStatus === "reval_draft" ? (
                      <button type="button" className="btn btn-sm green" onClick={() => onConfirmRevaluation(row.id)} disabled={pending}>
                        ยืนยัน JV ปรับปรุง
                      </button>
                    ) : row.liveStatus === "reversing_draft" ? (
                      <button type="button" className="btn btn-sm green" onClick={() => onConfirmReversing(row.id)} disabled={pending}>
                        ยืนยันรายการกลับรายการ
                      </button>
                    ) : row.liveStatus === "reversing_confirmed" ? (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => onUnconfirmReversing(row.id)} disabled={pending}>
                        ยกเลิกการยืนยันรายการกลับรายการ
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
