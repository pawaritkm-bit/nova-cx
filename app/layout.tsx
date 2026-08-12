import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NOVA-CX — ระบบวัดคุณภาพบริการ Finovas",
  description:
    "NOVA Customer Experience System — ระบบประเมินความพึงพอใจและติดตามคุณภาพบริการผ่าน LINE OA",
  // ★ PWA (wishlist ข้อ 1) — เปิดโหมด "Add to Home Screen" บน iOS Safari (iOS ไม่อ่าน manifest.json
  //   สำหรับสิ่งนี้ — ต้องมี meta apple-mobile-web-app-* ตรง ๆ) · manifest.ts (Android/Chrome) เชื่อมอัตโนมัติ
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "NOVA-CX",
  },
};

// ★ ก่อนหน้านี้ไม่มี viewport meta เลย — มือถือ (iOS/Android) จะ render หน้าเว็บที่ความกว้าง viewport
//   เดา ๆ ประมาณ 980px เสมอ (แม้จอจริงแคบกว่ามาก) ทำให้ @media (max-width: …) ที่มีอยู่แล้วในหลายไฟล์ CSS
//   ของระบบไม่ทำงานจริงบนมือถือเลยแม้จะเขียนไว้ถูกต้อง — นี่คือจุดที่กระทบมากที่สุดของ "ใช้ระบบบนมือถือ"
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1e3a8a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="th">
      <head>
        {/* ★ Next.js metadata API (appleWebApp ด้านบน) render แค่ "mobile-web-app-capable" (มาตรฐานใหม่ไม่มี
            prefix apple-) — iOS Safari รุ่นเก่ากว่า 17.4 อ่านเฉพาะชื่อเดิมที่มี prefix เท่านั้นถึงจะเปิดโหมด
            standalone ("เพิ่มไปหน้าจอโฮม") ได้ ต้องเติมด้วยมือแยกจาก metadata API */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/* ฟอนต์ไทยอ่านง่าย (Sarabun) โหลดจาก Google Fonts ตอน runtime
            — ไม่ผูกกับ build (กัน build ล้มเมื่อไม่มีเน็ต) */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
