import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Guard: หน้าบิลลูกค้า + pipeline เก็บบิล ต้องเป็น "image-only"
 *   เจ้าของต้องการเก็บ/แสดงเฉพาะ "รูปบิล" — ไม่ดึง/ไม่แสดงไฟล์ (PDF/เอกสาร) ที่ส่งในกลุ่ม
 *
 *   เทสต์นี้อ่าน source ตรง ๆ (query อยู่ใน server component / worker ที่ mock ยาก)
 *   เพื่อกัน regression กลับไปใช้ .in("attachment_type", ["image","file"]) โดยไม่ตั้งใจ
 */

function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
}

describe("bills pipeline queue — image-only", () => {
  const src = readSrc("lib/line/attachments.ts");

  it('candidate queue ใช้ .eq("attachment_type", "image")', () => {
    expect(src).toContain('.eq("attachment_type", "image")');
  });

  it('ไม่ป้อนไฟล์เข้าคิว: ไม่มี .in("attachment_type", ["image", "file"])', () => {
    expect(src).not.toContain('.in("attachment_type", ["image", "file"])');
  });
});

describe("bills page query — image-only", () => {
  const src = readSrc("app/chat-audit/bills/page.tsx");

  it('ดึงเฉพาะ .eq("attachment_type", "image")', () => {
    expect(src).toContain('.eq("attachment_type", "image")');
  });

  it('ไม่รวมไฟล์: ไม่มี .in("attachment_type", ["image", "file"])', () => {
    expect(src).not.toContain('.in("attachment_type", ["image", "file"])');
  });
});
