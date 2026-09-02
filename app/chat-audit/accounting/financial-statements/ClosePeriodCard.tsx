"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { closePeriodAction, cancelClosePeriodAction } from "./close-actions";

/**
 * การ์ด "ปิดบัญชีสิ้นงวด" — ★ 2026-09-02 (ขั้น 8 ครบ)
 *   เลือกเดือนสิ้นงวด → ปิดงวด: โอนรายได้/ค่าใช้จ่ายสะสมเข้ากำไรสะสม (JE ยืนยันทันที)
 *   ยกเลิกการปิดได้เสมอ (ถอนยืนยัน + ลบ JE ปิด)
 */
export default function ClosePeriodCard({
  customerId,
  defaultMonth,
  closedMonths,
}: {
  customerId: string;
  /** เดือนสิ้นงวดเริ่มต้น (YYYY-MM) — ปกติ = เดือนท้ายสุดที่มีข้อมูล */
  defaultMonth: string;
  /** เดือนที่ปิดไปแล้ว (จาก JE ปิดที่ยังอยู่) */
  closedMonths: string[];
}) {
  const router = useRouter();
  const [month, setMonth] = useState(defaultMonth);
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const isClosed = closedMonths.includes(month);

  function doClose() {
    if (
      !window.confirm(
        `ปิดบัญชีงวดสิ้นสุดเดือน ${month} ?\n\n• รายได้/ค่าใช้จ่ายสะสมถึงสิ้นเดือนนี้จะถูกโอนเข้า "กำไรสะสม"\n• หลังปิด งบกำไรขาดทุนของช่วงที่ปิดจะแสดงเป็นศูนย์ (เหมือนสมุดจริง) — พิมพ์/เก็บงบของงวดนี้ให้เสร็จก่อน\n• ยกเลิกการปิดได้ทุกเมื่อ`
      )
    )
      return;
    setMsg(null);
    startTransition(async () => {
      const r = await closePeriodAction({ customerId, month });
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  }

  function doCancel() {
    if (!window.confirm(`ยกเลิกการปิดงวด ${month} ? รายได้/ค่าใช้จ่ายจะกลับมาแสดงตามเดิม`)) return;
    setMsg(null);
    startTransition(async () => {
      const r = await cancelClosePeriodAction({ customerId, month });
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="card">
      <div className="strong" style={{ fontSize: 15, marginBottom: 4 }}>🔒 ปิดบัญชีสิ้นงวด</div>
      <p className="muted" style={{ marginTop: 0, marginBottom: 10, fontSize: 13 }}>
        โอนยอดรายได้–ค่าใช้จ่ายสะสมถึงสิ้นเดือนที่เลือก เข้า “กำไรสะสม” (สร้างใบสำคัญ JV ยืนยันทันที
        เข้าเล่มทั่วไป→แยกประเภท→งบเอง) · หลังปิด งบกำไรขาดทุนของช่วงที่ปิดจะเป็นศูนย์ —
        <strong> พิมพ์/เก็บงบของงวดก่อนปิดเสมอ</strong> · ยกเลิกการปิดได้
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          งวดสิ้นสุดเดือน
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{ padding: "5px 8px", border: "1px solid var(--line)", borderRadius: 8 }}
            aria-label="เดือนสิ้นงวด"
          />
        </label>
        {isClosed ? (
          <>
            <span style={{ fontSize: 13, color: "#166534", fontWeight: 700 }}>✓ งวดนี้ปิดแล้ว</span>
            <button type="button" className="btn danger" disabled={busy} onClick={doCancel}>
              {busy ? "กำลังยกเลิก…" : "ยกเลิกการปิดงวดนี้"}
            </button>
          </>
        ) : (
          <button type="button" className="btn" disabled={busy || !/^\d{4}-\d{2}$/.test(month)} onClick={doClose}>
            {busy ? "กำลังปิดงวด…" : "🔒 ปิดงวดนี้"}
          </button>
        )}
        {closedMonths.length > 0 ? (
          <span className="muted" style={{ fontSize: 12 }}>
            งวดที่ปิดแล้ว: {closedMonths.slice().sort().join(", ")}
          </span>
        ) : null}
      </div>
      {msg ? (
        <p style={{ marginTop: 8, marginBottom: 0, fontSize: 13, color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.ok ? "✓ " : "⚠ "}{msg.text}
        </p>
      ) : null}
    </div>
  );
}
