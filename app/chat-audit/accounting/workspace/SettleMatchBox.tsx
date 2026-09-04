"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/accounting/calc";
import type { SlipMatch } from "@/lib/accounting/slip-matching";
import { settleSlipAgainstBillAction } from "./settle-actions";

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
}: {
  customerId: string;
  slipEntryId: string;
  entryType: "purchase" | "sale";
  matches: SlipMatch[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [targetId, setTargetId] = useState(matches[0]?.entryId ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (matches.length === 0) return null;
  const best = matches.find((m) => m.entryId === targetId) ?? matches[0];
  const verb = entryType === "sale" ? "รับชำระ + ตัดลูกหนี้" : "จ่ายชำระ + ตัดเจ้าหนี้";

  const settle = () => {
    setMsg(null);
    start(async () => {
      const r = await settleSlipAgainstBillAction({ customerId, slipEntryId, targetEntryId: targetId });
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  };

  return (
    <div className="wsp-match">
      <div className="wsp-match-h">
        🔗 จับคู่บิลเชื่อค้างได้: <b>{best.docNo || "—"}</b> · {best.counterpartyName || "—"} ·
        ค้าง {formatMoney(best.outstanding)} ({thaiDate(best.docDate)})
        {best.amountExact ? <span className="wsp-match-exact">ยอดตรงพอดี</span> : null}
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
                {m.docNo || "—"} · ค้าง {formatMoney(m.outstanding)}{m.amountExact ? " ✓ยอดตรง" : ""}
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
