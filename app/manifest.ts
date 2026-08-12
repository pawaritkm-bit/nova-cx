import type { MetadataRoute } from "next";

/**
 * PWA manifest (wishlist ข้อ 1 — ใช้ระบบบนมือถือแบบแอป) — Next.js สร้าง /manifest.webmanifest
 * ให้อัตโนมัติจากไฟล์นี้ + inject <link rel="manifest"> ใน <head> เอง ไม่ต้องเพิ่มด้วยมือ
 *
 * ★ ไม่มี service worker ตั้งใจ — ระบบนี้เป็นระบบบัญชี/ประเมินคุณภาพที่ต้องข้อมูลสดใหม่เสมอ
 *   service worker แบบ cache-first เสี่ยงโชว์หน้าเก่า/ข้อมูลเก่าให้ผู้ใช้เห็นหลัง deploy ใหม่ —
 *   แค่ manifest + apple-touch-icon (ดู app/apple-icon.tsx) ก็เพียงพอให้ "เพิ่มไปหน้าจอโฮม" ได้แล้ว
 *   ทั้ง iOS และ Android โดยไม่ต้องแลกกับความเสี่ยงเรื่อง cache ข้อมูลเก่า
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NOVA-CX — ระบบวัดคุณภาพบริการ Finovas",
    short_name: "NOVA-CX",
    description: "ระบบบัญชี + ประเมินคุณภาพบริการ Finovas",
    start_url: "/chat-audit",
    display: "standalone",
    background_color: "#f3f5f8", // ตรงกับ tailwind.config brand.bg (theme("colors.brand.bg") ใน globals.css)
    theme_color: "#1e3a8a",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
