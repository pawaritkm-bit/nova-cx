import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Guard นโยบายการเก็บ/แสดงบิล:
 *   - pipeline เก็บบิล (attachments queue): #4 เปิดให้ดึง "รูป + ไฟล์เอกสาร" (image + file)
 *     → นักบัญชีได้ไฟล์ PDF/Excel มาสร้าง bill_entry ต่อ (video/audio ยังไม่ป้อน)
 *   - หน้าอัลบั้มบิลลูกค้า (bills page): ยังเป็น "image-only" — โชว์เฉพาะรูปบิล
 *
 *   เทสต์นี้อ่าน source ตรง ๆ (query อยู่ใน server component / worker ที่ mock ยาก)
 *   เพื่อกัน regression นโยบายทั้งสองฝั่งเปลี่ยนโดยไม่ตั้งใจ
 */

function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
}

describe("bills pipeline queue — image + file (#4)", () => {
  const src = readSrc("lib/line/attachments.ts");

  it('candidate queue ป้อนทั้งรูปและไฟล์: .in("attachment_type", ["image", "file"])', () => {
    expect(src).toContain('.in("attachment_type", ["image", "file"])');
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
