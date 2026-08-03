"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * แถบ "AI กำลังอ่านบิลเบื้องหลัง" — โผล่หลังอัปไฟล์ (URL มี ?uploaded=<id>)
 *   ★ อัปไฟล์แบบ async: ผู้ใช้ไม่ต้องรอ ~90 วิ — เข้าหน้าเลย AI อ่านเบื้องหลัง
 *   ★ รีเฟรชอัตโนมัติ 1 ครั้งเมื่อครบ ~95 วิ (ข้อมูลที่ AI ลงจะขึ้น + แถบหายเอง) หรือกด "รีเฟรช" เอง
 */
export default function UploadProcessingBar({ backHref }: { backHref: string }) {
  const router = useRouter();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      router.push(backHref); // ออกจาก ?uploaded=… + โหลดข้อมูลใหม่ (ที่ AI ลงแล้ว)
      router.refresh();
    }, 95000);
    return () => clearTimeout(t);
  }, [router, backHref]);

  if (hidden) return null;

  const refreshNow = () => {
    router.push(backHref);
    router.refresh();
  };

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
        padding: "10px 16px",
        borderRadius: 10,
        boxShadow: "0 8px 28px rgba(0,0,0,.28)",
        maxWidth: "92vw",
        fontSize: 14,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 15,
          height: 15,
          borderRadius: "50%",
          border: "2px solid rgba(255,255,255,.35)",
          borderTopColor: "#fff",
          display: "inline-block",
          animation: "spin 0.8s linear infinite",
        }}
      />
      <span>🤖 AI กำลังอ่านบิลเบื้องหลัง… (~1–2 นาที) ข้อมูลจะขึ้นเอง</span>
      <button type="button" className="btn" onClick={refreshNow}>รีเฟรชดูตอนนี้</button>
      <button
        type="button"
        onClick={() => setHidden(true)}
        aria-label="ปิด"
        style={{ background: "transparent", border: "none", color: "#cbd5e1", cursor: "pointer", fontSize: 16 }}
      >
        ✕
      </button>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
