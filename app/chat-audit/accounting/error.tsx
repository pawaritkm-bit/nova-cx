"use client";

/**
 * Error boundary ของหน้า "ลงบันทึกบัญชี" (route segment)
 *
 * กันหน้า "Application error" ตายสนิท: ถ้า render/ดึงข้อมูลชั่วคราวล้ม (backend blip /
 * cold start / storage timeout) จะแสดงกล่องพร้อมปุ่ม "ลองใหม่" (reset) แทน — ผู้ใช้กดครั้งเดียว
 * มักกลับมาใช้งานได้ (error แบบ transient) โดยไม่ต้องรีเฟรชทั้งเบราว์เซอร์
 *
 * ★ PDPA: ไม่โชว์/ไม่ log ข้อความ error ดิบ (อาจมีรายละเอียดภายใน) — โชว์ข้อความสุภาพ + digest เท่านั้น
 */
export default function AccountingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="card" style={{ maxWidth: 560, margin: "48px auto", textAlign: "center" }}>
      <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
      <h2 style={{ margin: "0 0 8px" }}>โหลดหน้าลงบันทึกบัญชีไม่สำเร็จชั่วคราว</h2>
      <p style={{ color: "var(--muted, #667)", margin: "0 0 20px", lineHeight: 1.6 }}>
        อาจเป็นการสะดุดของระบบชั่วขณะ (เชื่อมต่อฐานข้อมูล/ไฟล์บิล) — กด “ลองใหม่” ได้เลย
        <br />
        ถ้ายังไม่หาย ลองรีเฟรชหน้าหรือแจ้งผู้ดูแลระบบ
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        <button type="button" className="btn" onClick={() => reset()}>
          ลองใหม่
        </button>
        <a href="/chat-audit/accounting" className="btn btn-ghost">
          กลับหน้าเลือกนักบัญชี
        </a>
      </div>
      {error?.digest ? (
        <p style={{ color: "var(--muted, #99a)", fontSize: 12, marginTop: 16 }}>
          รหัสอ้างอิง: {error.digest}
        </p>
      ) : null}
    </div>
  );
}
