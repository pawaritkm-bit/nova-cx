"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteEntryAction } from "../actions";

/**
 * ปุ่มลบบิลในโต๊ะทำงาน (เผื่อ AI ดึงมาไม่ใช่บิล) — soft delete + refresh
 *   ★ ยืนยันก่อนลบเสมอ · กู้คืนได้ที่หน้าเดิม (undo) · best-effort ไม่ throw
 */
export default function DeleteBillButton({ entryId }: { entryId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="wsp-btn danger"
        disabled={pending}
        title="ลบบิลนี้ (เผื่อไม่ใช่บิล)"
        onClick={() => {
          if (!window.confirm("ลบบิลนี้? (เผื่อ AI ดึงมาไม่ใช่บิล) — กู้คืนได้ที่หน้าแบบเดิม")) return;
          setErr(null);
          start(async () => {
            const r = await deleteEntryAction(entryId);
            if (r.ok) router.refresh();
            else setErr(r.message);
          });
        }}
      >
        {pending ? "กำลังลบ…" : "🗑 ลบ"}
      </button>
      {err ? <span className="wsp-delerr">{err}</span> : null}
    </>
  );
}
