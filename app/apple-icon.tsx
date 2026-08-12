import { ImageResponse } from "next/og";

// ★ PWA (wishlist ข้อ 1) — ไอคอน "เพิ่มไปหน้าจอโฮม" บน iOS Safari
//   iOS อ่านจาก <link rel="apple-touch-icon"> เท่านั้น (ไม่อ่าน manifest.json/icon.svg เลย)
//   Next.js สร้างไฟล์ + inject link tag ให้อัตโนมัติจาก convention นี้ — ใช้ ImageResponse (มีในตัว
//   next/og, ไม่ต้องเพิ่ม dependency เช่น sharp) แทนการแปลง icon.svg เป็น PNG ด้วยมือ
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1e3a8a",
          borderRadius: 40,
        }}
      >
        <span style={{ fontSize: 90, fontWeight: 700, color: "#ffffff", fontFamily: "sans-serif" }}>N</span>
      </div>
    ),
    { ...size }
  );
}
