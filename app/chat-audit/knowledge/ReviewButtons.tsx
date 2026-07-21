"use client";

import { useActionState } from "react";
import { setKnowledgeStatusAction, type ActionResult } from "@/lib/knowledge/actions";

/**
 * ปุ่มอนุมัติ/ตัดออก 1 รายการความรู้ (client) — เรียก server action ผ่าน useActionState
 *   แสดงสถานะปัจจุบัน + ผลลัพธ์ของ action (ok/err)
 *   ★ ปุ่มที่ตรงกับสถานะปัจจุบันจะถูกซ่อน (เช่น approved แล้วไม่ต้องมีปุ่ม "อนุมัติ" อีก)
 */
export default function ReviewButtons({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    setKnowledgeStatusAction,
    null
  );

  return (
    <div className="kn-review">
      <div className="kn-review-btns">
        {status !== "approved" ? (
          <form action={formAction} className="inline-form">
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="status" value="approved" />
            <button type="submit" className="badge b-green" title="อนุมัติเข้าคลัง">
              ✓ อนุมัติ
            </button>
          </form>
        ) : null}
        {status !== "rejected" ? (
          <form action={formAction} className="inline-form">
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="status" value="rejected" />
            <button type="submit" className="badge b-red" title="ตัดออกจากคลัง">
              ✕ ตัดออก
            </button>
          </form>
        ) : null}
      </div>
      {state ? (
        <p className={`action-msg ${state.ok ? "ok" : "err"}`} style={{ fontSize: 11 }}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
