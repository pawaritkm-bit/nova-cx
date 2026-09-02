/**
 * Loading boundary ของหน้า "งบการเงิน" — ★ perf 2026-09-02 (ผู้ใช้: "กดปิดเด้งกลับช้า")
 * หน้านี้คำนวณงบ 5 รายงานฝั่ง server (หลายวินาที) — มี boundary แล้ว navigation
 * เด้งมาที่หน้านี้ "ทันที" (โชว์สถานะกำลังคำนวณ) แทนค้างอยู่หน้าเดิมจนคำนวณเสร็จ
 */
export default function ReportsLoading() {
  return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <div
        aria-hidden="true"
        style={{
          width: 34,
          height: 34,
          margin: "0 auto 14px",
          border: "3px solid #dbeafe",
          borderTopColor: "#2563eb",
          borderRadius: "50%",
          animation: "accrep-spin 0.8s linear infinite",
        }}
      />
      <div style={{ fontWeight: 700, color: "#1e3a8a" }}>กำลังคำนวณงบ…</div>
      <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
        สมุดรายวัน → แยกประเภท → งบทดลอง → งบการเงิน
      </div>
      <style>{`@keyframes accrep-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
