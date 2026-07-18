"use client";

/**
 * ปุ่มพิมพ์/บันทึก PDF — ใช้ window.print() (เบราว์เซอร์มี "Save as PDF" ในตัว)
 *   print stylesheet (chat-admin.css @media print) ซ่อนเมนู/ปุ่ม เหลือเฉพาะกระดาษรายงาน
 *   → ได้ PDF จัดรูปแบบสวยโดยไม่ต้องเพิ่ม dependency ฝั่ง server
 */
export default function PrintButton() {
  return (
    <button type="button" className="btn" onClick={() => window.print()}>
      📄 พิมพ์ / บันทึก PDF
    </button>
  );
}
