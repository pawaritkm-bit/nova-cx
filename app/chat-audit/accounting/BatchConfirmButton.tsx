"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmGreenBillsAction } from "./actions";

/**
 * ปุ่ม "ยืนยันทั้งหมดที่เขียว" — batch-confirm บิล draft ที่พร้อม (ระบุซื้อ/ขาย + มียอด + ไม่ใช่ AI เดา)
 *   count = จำนวนใบเขียวในมุมมองปัจจุบัน (แสดงผล) · action ยืนยันใบพร้อมทั้งหมดของลูกค้ารายนี้
 */
export default function BatchConfirmButton({
  customerId,
  count,
}: {
  customerId: string;
  count: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (count <= 0) return null;

  return (
    <span className="wsp-batch-confirm">
      <button
        type="button"
        className="btn btn-green"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`ยืนยันบิลที่พร้อม ${count} ใบ?\n(ข้ามใบที่ AI "เดา" ฝั่งซื้อ/ขาย — ต้องตรวจเอง)`)) return;
          setMsg(null);
          startTransition(async () => {
            const r = await confirmGreenBillsAction(customerId);
            if (r.ok) {
              setMsg(`✓ ยืนยันแล้ว ${r.confirmed.toLocaleString("th-TH")} ใบ`);
              router.refresh();
            } else {
              setMsg(r.message ?? "ยืนยันไม่สำเร็จ");
            }
          });
        }}
      >
        {pending ? "กำลังยืนยัน…" : `✓ ยืนยันทั้งหมดที่เขียว (${count.toLocaleString("th-TH")})`}
      </button>
      {msg ? <span className="wsp-batch-msg">{msg}</span> : null}
    </span>
  );
}
