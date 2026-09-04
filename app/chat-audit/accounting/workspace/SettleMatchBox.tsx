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
  others = [],
  slipNet,
  moneyCode,
  moneyName,
}: {
  customerId: string;
  slipEntryId: string;
  entryType: "purchase" | "sale";
  matches: SlipMatch[];
  /** ★ 2026-09-04 "ถ้าจะจับเองต้องกดตรงไหน" — ใบเชื่อค้างทั้งหมดของลูกค้า (ฝั่งเดียวกัน)
   *  ที่ AI ไม่ได้เสนอ → โผล่ท้าย dropdown ให้เลือกจับเองได้เสมอ */
  others?: SlipMatch[];
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
  const othersList = others ?? [];
  const all = [...matches, ...othersList];
  if (all.length === 0) return null;
  const manualOnly = matches.length === 0; // AI จับไม่ได้ — โหมดจับเองล้วน
  const best = all.find((m) => m.entryId === targetId) ?? null;
  const verb = entryType === "sale" ? "รับชำระ + ตัดลูกหนี้" : "จ่ายชำระ + ตัดเจ้าหนี้";
  // ★ 2026-09-04: "ai ใส่เดบิตเครดิตให้ด้วย" — โชว์คู่บัญชีที่จะลงจริงเมื่อกด
  const payAmount = best ? Math.min(slipNet, best.outstanding) : slipNet;
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
        <div className="wsp-match-act">
          <span className="wsp-match-h">✓ {settled.text}</span>
          <button
            type="button"
            className="wsp-btn ghost"
            onClick={undo}
            disabled={pending}
            title={`เข้าสมุดรายวัน${entryType === "sale" ? "รับเงิน" : "จ่ายเงิน"}แล้ว · ยอดค้างถูกตัดแล้ว — กดเพื่อย้อนกลับ`}
          >
            {pending ? "กำลังเลิกทำ…" : "↩ เลิกทำ"}
          </button>
        </div>
        {msg && !msg.ok ? <span style={{ fontSize: 11, color: "#b91c1c" }}>⚠ {msg.text}</span> : null}
      </div>
    );
  }

  const optionLabel = (m: SlipMatch, isAi: boolean) =>
    `${m.docNo || "—"} · ${m.counterpartyName || "—"} · ค้าง ${formatMoney(m.outstanding)}${
      isAi ? (m.nameMatch && m.amountExact ? " ✓ชื่อ+ยอดตรง" : m.amountExact ? " ✓ยอดตรง" : " ✓ชื่อตรง") : ""
    }`;

  // ★ 2026-09-04 "มีคำอธิบายมันดูรก" — เหลือ 2 บรรทัด (สรุป + ปุ่ม)
  //   ป้ายสั้น · เหตุผลเต็ม/เดบิตเครดิต/ข้อยกเว้น ย้ายไป tooltip (ชี้เมาส์ค้าง)
  const badge = !best ? null : best.nameMatch && best.amountExact ? (
    <span className="wsp-match-exact" title="ชื่อผู้โอนและยอดเงินตรงกับใบเชื่อค้างพอดี">ชื่อ+ยอดตรง</span>
  ) : best.amountExact ? (
    <span className="wsp-match-exact warn" title="ยอดตรงพอดี แต่ชื่อผู้โอนไม่ตรง (ลูกค้าอาจโอนจากบัญชีส่วนตัว)">ยอดตรง</span>
  ) : best.nameMatch ? (
    <span className="wsp-match-exact name" title="ชื่อตรง แต่ยอดสลิปไม่เท่ายอดค้าง — จะตัดเท่าที่จ่ายจริง">ชื่อตรง</span>
  ) : (
    <span className="wsp-match-exact name">เลือกเอง</span>
  );
  const drcrTitle = entryType === "sale"
    ? `เดบิต ${moneyCode} ${moneyName} / เครดิต ${arapCode} ${arapName} = ${formatMoney(payAmount)} → เข้าสมุดรายวันรับเงิน`
    : `เดบิต ${arapCode} ${arapName} / เครดิต ${moneyCode} ${moneyName} = ${formatMoney(payAmount)} → เข้าสมุดรายวันจ่ายเงิน`;

  return (
    <div className="wsp-match">
      <div className="wsp-match-h">
        {manualOnly ? (
          <>🔗 จับคู่เอง — เลือกใบเชื่อค้าง ({all.length.toLocaleString("th-TH")} ใบ)</>
        ) : best ? (
          <span title={`${best.counterpartyName || "—"} · วันที่ ${thaiDate(best.docDate)}${best.isDraft ? " · ใบวางบิลยังเป็นร่าง — ระบบจะยืนยันให้อัตโนมัติ" : ""}`}>
            🔗 <b>{best.docNo || "—"}</b> · ค้าง {formatMoney(best.outstanding)}
            {badge}
            {best.isDraft ? <span className="wsp-match-exact name" title="ระบบจะยืนยันใบวางบิลให้อัตโนมัติตอนตัดยอด">ร่าง</span> : null}
          </span>
        ) : (
          <>🔗 เลือกใบเชื่อค้างที่จะตัด…</>
        )}
      </div>
      <div className="wsp-match-act">
        <button
          type="button"
          className="wsp-btn primary"
          onClick={settle}
          disabled={pending || !targetId}
          title={`${drcrTitle} — ถ้าไม่ใช่การชำระ ใช้ปุ่ม ✓ ยืนยัน ปกติ (ลง${entryType === "sale" ? "รายได้" : "ค่าใช้จ่าย"})`}
        >
          {pending ? "กำลังบันทึก…" : `✓ ${verb}`}
        </button>
        {/* ★ "ถ้าจะจับเอง" — dropdown มีทุกใบค้างเสมอ: ใบที่ AI เสนอ (ติดป้ายเหตุผล) + ใบอื่นทั้งหมด */}
        {all.length > 1 || manualOnly ? (
          <select
            className="wsp-move-select"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={pending}
            aria-label="เลือกบิลเชื่อที่จะตัด"
          >
            {manualOnly ? <option value="">— เลือกใบเชื่อค้าง —</option> : null}
            {matches.map((m) => (
              <option key={m.entryId} value={m.entryId}>{optionLabel(m, true)}</option>
            ))}
            {othersList.length > 0 ? (
              <optgroup label="ใบเชื่อค้างอื่น ๆ (จับเอง)">
                {othersList.map((m) => (
                  <option key={m.entryId} value={m.entryId}>{optionLabel(m, false)}</option>
                ))}
              </optgroup>
            ) : null}
          </select>
        ) : null}
        {/* ★ "ai ใส่เดบิตเครดิตให้ด้วย" — ย่อเป็นบรรทัดเล็ก (รายละเอียดเต็มอยู่ใน tooltip ปุ่ม) */}
        {best ? (
          <span className="wsp-match-drcr" title={drcrTitle}>
            {entryType === "sale" ? (
              <><b className="dr">Dr</b> {moneyCode} · <b className="cr">Cr</b> {arapCode}</>
            ) : (
              <><b className="dr">Dr</b> {arapCode} · <b className="cr">Cr</b> {moneyCode}</>
            )}{" "}
            {formatMoney(payAmount)}
          </span>
        ) : null}
      </div>
      {msg ? (
        <span style={{ fontSize: 11, color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.ok ? "✓ " : "⚠ "}{msg.text}
        </span>
      ) : null}
    </div>
  );
}
