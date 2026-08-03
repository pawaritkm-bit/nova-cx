"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCustomerShareCircleAction } from "./share-circle-actions";

/**
 * สวิตช์ "ลูกค้าเป็นท้าวแชร์" (client) — วางในหัวการ์ดลูกค้าของหน้าลงบันทึกบัญชี
 *   ★ เปิดครั้งเดียว → แท็บ "วงแชร์" โผล่ทันที (แก้ปัญหาไก่กับไข่ — ลูกค้าใหม่ยัง 0 วง)
 *   ★ เปิดแล้วโชว์ badge "ท้าวแชร์" + ปิดได้ · เฉพาะ admin เห็น (server เป็นคน gate ว่าจะ render ไหม)
 *   ★ กลมกลืน (คลาส acc-*) · หลังสลับ → router.refresh (แท็บ/สวิตช์ sync กับ server)
 */
export default function ShareCircleToggle({
  customerId,
  initialOn,
}: {
  customerId: string;
  initialOn: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(initialOn);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function toggle(next: boolean) {
    setErr(null);
    startTransition(async () => {
      const res = await setCustomerShareCircleAction(customerId, next);
      if (!res.ok) {
        setErr(res.message);
        return;
      }
      setOn(next);
      router.refresh();
    });
  }

  return (
    <span className="acc-sc-toggle" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      {on ? (
        <>
          <span className="vat-badge yes" title="ลูกค้ารายนี้ถูกตั้งเป็นท้าวแชร์">
            🎯 ท้าวแชร์
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (window.confirm("ยกเลิกสถานะท้าวแชร์ของลูกค้ารายนี้? (แท็บวงแชร์จะซ่อนถ้ายังไม่มีวง)")) {
                toggle(false);
              }
            }}
            disabled={pending}
          >
            {pending ? "…" : "ยกเลิกท้าวแชร์"}
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-ghost" onClick={() => toggle(true)} disabled={pending}>
          {pending ? "…" : "＋ ตั้งเป็นลูกค้าท้าวแชร์"}
        </button>
      )}
      {err ? <span className="action-msg err">{err}</span> : null}
    </span>
  );
}
