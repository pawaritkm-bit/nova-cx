"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmEntryDirectAction } from "../actions";

/**
 * ปุ่ม "✓ ยืนยัน" บนการ์ดบิล (โต๊ะทำงาน) — ★ 2026-09-03 ผู้ใช้: "ปุ่มตรวจกับปุ่มยืนยัน
 * ให้อยู่แยกกัน คือสามารถยืนยันบิลได้ในหน้านี้เลย หรือกดเข้าไปยืนยันด้านในก็ได้"
 *   ★ ถามยืนยันก่อนเสมอ — ระบบไม่มีปุ่มถอนยืนยัน (กันกดพลาดแล้วแก้ไม่ได้)
 */
export default function ConfirmBillButton({ entryId }: { entryId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="wsp-btn primary"
        disabled={pending}
        title="ยืนยันบิลนี้เลย ไม่ต้องเปิดหน้าตรวจด้านใน"
        onClick={() => {
          if (!window.confirm("ยืนยันบิลนี้? (ยืนยันแล้วเข้าสมุดบัญชี/รายงานภาษีทันที)")) return;
          setErr(null);
          start(async () => {
            const r = await confirmEntryDirectAction(entryId);
            if (r.ok) router.refresh();
            else setErr(r.message);
          });
        }}
      >
        {pending ? "กำลังยืนยัน…" : "✓ ยืนยัน"}
      </button>
      {err ? <span className="wsp-delerr">{err}</span> : null}
    </>
  );
}
