import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NOVA-CX — ระบบวัดคุณภาพบริการ Finovas",
  description:
    "NOVA Customer Experience System — ระบบประเมินความพึงพอใจและติดตามคุณภาพบริการผ่าน LINE OA",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="th">
      <head>
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
