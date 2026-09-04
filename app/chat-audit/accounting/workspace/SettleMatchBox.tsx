"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/accounting/calc";
import type { SlipMatch } from "@/lib/accounting/slip-matching";
import { settleSlipAgainstBillAction, undoSettleSlipAction } from "./settle-actions";

/** วันที่ ISO → วว/ดด/พ.ศ. สั้น ๆ */
function thaiDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

/**
 * กล่องจับคู่สลิป ↔ บิลเชื่อค้าง บนการ์ดโต๊ะทำงาน — ★ 2026-09-04 ผู้ใช้อนุมัติ ("ทำจริง")
 *   "ลูกหนี้/เจ้าหนี้ คือบิลที่ไม่มีสลิปมาจับคู่" — สลิปที่ชื่อผู้โอน/ผู้รับโอนตรงกับบิลค้าง
 *   → ปุ่มเดียวจบ: รับ/จ่ายชำระ (Dr เงิน / Cr ลูกหนี้ · Dr เจ้าหนี้ / Cr เงิน) + ตัดยอดค้าง
 *   ไม่ใช่การชำระ = ใช้ปุ่มยืนยันปกติ (ลงรายได้/ค่าใช้จ่ายตามเดิม)
 */
export default function SettleMatchBox({
  customerId,
  slipEntryId,
  entryType,
  matches,
  slipNet,
  moneyCode,
  moneyName,
}: {
  customerId: string;
  slipEntryId: string;
  entryType: "purchase" | "sale";
  matches: SlipMatch[];
  /** ยอดสุทธิของสลิป — ใช้โชว์แถวเดบิต/เครดิต (จ่ายจริง = min(ยอดสลิป, ยอดค้าง)) */
  slipNet: number;
  /** บัญชีฝั่งเงินของสลิป (เช่น 1020 เงินฝากธนาคาร) */
  moneyCode: string;
  moneyName: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [targetId, setTargetId] = useState(matches[0]?.entryId ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // ★ 2026-09-04: หลังจับคู่สำเร็จ ค้างสถานะไว้พร้อมปุ่ม "เลิกทำ" (กด AI จับผิดยังย้อนได้ทันที)
  const [settled, setSettled] = useState<{ paymentId: string; text: string } | null>(null);
  if (matches.length === 0) return null;
  const best = matches.find((m) => m.entryId === targetId) ?? matches[0];
  const verb = entryType === "sale" ? "รับชำระ + ตัดลูกหนี้" : "จ่ายชำระ + ตัดเจ้าหนี้";
  // ★ 2026-09-04: "ai ใส่เดบิตเครดิตให้ด้วย" — โชว์คู่บัญชีที่จะลงจริงเมื่อกด
  const payAmount = Math.min(slipNet, best.outstanding);
  const arapCode = entryType === "sale" ? "1140" : "2010";
  const arapName = entryType === "sale" ? "ลูกหนี้การค้า" : "เจ้าหนี้การค้า";

  const settle = () => {
    setMsg(null);
    start(async () => {
      const r = await settleSlipAgainstBillAction({ customerId, slipEntryId, targetEntryId: targetId });
      if (r.ok && r.paymentId) {
        setSettled({ paymentId: r.paymentId, text: r.message });
      } else {
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) router.refresh();
      }
    });
  };

  const undo = () => {
    if (!settled) return;
    start(async () => {
      const r = await undoSettleSlipAction({ customerId, paymentId: settled.paymentId, slipEntryId });
      if (r.ok) {
        setSettled(null);
        setMsg({ ok: true, text: r.message });
        router.refresh();
      } else {
        setMsg({ ok: false, text: r.message });
      }
    });
  };

  // จับคู่สำเร็จแล้ว → แถบเขียวสรุป + ปุ่มเลิกทำ (การ์ดจะหายไปเองเมื่อรีเฟรช/เลื่อนหน้า)
  if (settled) {
    return (
      <div className="wsp-match">
        <div className="wsp-match-h">✓ {settled.text}</div>
        <div className="wsp-match-act">
          <button type="button" className="wsp-btn ghost" onClick={undo} disabled={pending}>
            {pending ? "กำลังเลิกทำ…" : "↩ เลิกทำ (จับคู่ผิดใบ)"}
          </button>
          <span className="wsp-match-hint">เข้าสมุดรายวัน{entryType === "sale" ? "รับเงิน" : "จ่ายเงิน"}แล้ว · ยอดค้างถูกตัดแล้ว</span>
        </div>
        {msg && !msg.ok ? <span style={{ fontSize: 11, color: "#b91c1c" }}>⚠ {msg.text}</span> : null}
      </div>
    );
  }

  return (
    <div className="wsp-match">
      <div className="wsp-match-h">
        🔗 จับคู่บิลเชื่อค้างได้: <b>{best.docNo || "—"}</b> · {best.counterpartyName || "—"} ·
        ค้าง {formatMoney(best.outstanding)} ({thaiDate(best.docDate)})
        {best.nameMatch && best.amountExact ? (
          <span className="wsp-match-exact">ชื่อ + ยอดตรงพอดี</span>
        ) : best.amountExact ? (
          <span className="wsp-match-exact warn">ยอดตรงพอดี — ชื่อผู้โอนไม่ตรง (อาจโอนบัญชีส่วนตัว)</span>
        ) : (
          <span className="wsp-match-exact name">ชื่อตรง (ยอดไม่เท่ายอดค้าง)</span>
        )}
        {best.isDraft ? (
          <span className="wsp-match-exact name">ใบวางบิลยังเป็นร่าง — ระบบจะยืนยันให้อัตโนมัติ</span>
        ) : null}
      </div>
      {/* ★ 2026-09-04: "ai ใส่เดบิตเครดิตให้ด้วย" — คู่บัญชีที่จะลงจริงเมื่อกดปุ่ม */}
      <div className="wsp-match-post">
        {entryType === "sale" ? (
          <>
            <span><b className="dr">เดบิต</b> {moneyCode} {moneyName} <b>{formatMoney(payAmount)}</b></span>
            <span><b className="cr">เครดิต</b> {arapCode} {arapName} <b>{formatMoney(payAmount)}</b></span>
          </>
        ) : (
          <>
            <span><b className="dr">เดบิต</b> {arapCode} {arapName} <b>{formatMoney(payAmount)}</b></span>
            <span><b className="cr">เครดิต</b> {moneyCode} {moneyName} <b>{formatMoney(payAmount)}</b></span>
          </>
        )}
        <span className="wsp-match-hint">→ สมุดรายวัน{entryType === "sale" ? "รับเงิน" : "จ่ายเงิน"}</span>
      </div>
      <div className="wsp-match-act">
        <button type="button" className="wsp-btn primary" onClick={settle} disabled={pending || !targetId}>
          {pending ? "กำลังบันทึก…" : `✓ ${verb}`}
        </button>
        {matches.length > 1 ? (
          <select
            className="wsp-move-select"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={pending}
            aria-label="เลือกบิลเชื่อที่จะตัด"
          >
            {matches.map((m) => (
              <option key={m.entryId} value={m.entryId}>
                {m.docNo || "—"} · ค้าง {formatMoney(m.outstanding)}
                {m.nameMatch && m.amountExact ? " ✓ชื่อ+ยอดตรง" : m.amountExact ? " ✓ยอดตรง" : " ✓ชื่อตรง"}
              </option>
            ))}
          </select>
        ) : null}
        <span className="wsp-match-hint">ไม่ใช่การชำระ → ใช้ปุ่ม ✓ ยืนยัน ปกติ (ลง{entryType === "sale" ? "รายได้" : "ค่าใช้จ่าย"})</span>
      </div>
      {msg ? (
        <span style={{ fontSize: 11, color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.ok ? "✓ " : "⚠ "}{msg.text}
        </span>
      ) : null}
    </div>
  );
}
