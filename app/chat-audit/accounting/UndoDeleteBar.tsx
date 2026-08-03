"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreEntryAction } from "./actions";

/**
 * แถบ "เลิกทำ" หลังลบบิล (undo) — โผล่ล่างจอเมื่อ URL มี ?undo=<entryId>
 *   กด "เลิกทำ" → กู้บิลกลับ (restoreEntryAction) · ไม่กดก็หายไปเองใน ~12 วิ (บิลยังลบอยู่ กู้ทีหลังไม่ได้)
 *   ★ บิลลบแบบ soft-delete (เก็บไฟล์ไว้) จึงกู้คืนได้จริง
 */
export default function UndoDeleteBar({
  entryId,
  backHref,
}: {
  entryId: string;
  backHref: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [hidden, setHidden] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // หายเองใน 12 วิ (เลยเวลา = บิลยังลบอยู่)
  useEffect(() => {
    const t = setTimeout(() => setHidden(true), 12000);
    return () => clearTimeout(t);
  }, []);

  if (hidden) return null;

  function undo() {
    setErr(null);
    startTransition(async () => {
      const res = await restoreEntryAction(entryId);
      if (res.ok) {
        setHidden(true);
        router.push(backHref); // ออกจาก ?undo=...
        router.refresh();
      } else {
        setErr(res.message);
      }
    });
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 24,
        transform: "translateX(-50%)",
        zIndex: 1000,
        display: "flex",
        gap: 12,
        alignItems: "center",
        background: "#1f2937",
        color: "#fff",
        padding: "10px 14px",
        borderRadius: 10,
        boxShadow: "0 8px 28px rgba(0,0,0,.28)",
        maxWidth: "92vw",
      }}
    >
      <span>🗑️ ลบบิลแล้ว</span>
      {err ? <span style={{ color: "#fca5a5", fontSize: 13 }}>{err}</span> : null}
      <button type="button" className="btn" onClick={undo} disabled={pending}>
        {pending ? "กำลังกู้คืน…" : "↩ เลิกทำ"}
      </button>
      <button
        type="button"
        onClick={() => setHidden(true)}
        aria-label="ปิด"
        style={{ background: "transparent", border: "none", color: "#cbd5e1", cursor: "pointer", fontSize: 16 }}
      >
        ✕
      </button>
    </div>
  );
}
