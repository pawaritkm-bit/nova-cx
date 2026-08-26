import { describe, it, expect } from "vitest";
import sharp from "sharp";

import { downscaleImageIfLarge, prepareImageForClassification } from "@/lib/accounting/image-prep";

async function makeImage(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: "#ffffff" } })
    .png()
    .toBuffer();
}

describe("downscaleImageIfLarge", () => {
  it("รูปใหญ่เกินขอบ (4000px) → ย่อ ≤1600px + แปลงเป็น jpeg", async () => {
    const big = await makeImage(4000, 2000);
    const out = await downscaleImageIfLarge(big, "image/png");
    const meta = await sharp(out.data).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1600);
    expect(out.mime).toBe("image/jpeg");
  });

  it("รูปเล็ก → คืนต้นฉบับ (ไม่แตะ)", async () => {
    const small = await makeImage(500, 500);
    const out = await downscaleImageIfLarge(small, "image/png");
    expect(out.mime).toBe("image/png");
    expect(out.data).toBe(small);
  });

  it("ไม่ใช่รูป (PDF) → คืนต้นฉบับ", async () => {
    const buf = Buffer.from("%PDF-1.4 dummy");
    const out = await downscaleImageIfLarge(buf, "application/pdf");
    expect(out.data).toBe(buf);
    expect(out.mime).toBe("application/pdf");
  });

  it("ไฟล์เสีย (ไม่ใช่รูปจริง แต่ mime image) → degrade คืนต้นฉบับ ไม่ throw", async () => {
    const buf = Buffer.from("not an image");
    const out = await downscaleImageIfLarge(buf, "image/png");
    expect(out.data).toBe(buf);
  });
});

describe("prepareImageForClassification", () => {
  it("ย่อสำเนาสำหรับคัดประเภทเหลือไม่เกิน 768px", async () => {
    const image = await makeImage(2400, 1200);
    const out = await prepareImageForClassification(image, "image/png");
    const meta = await sharp(out.data).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(768);
    expect(out.mime).toBe("image/jpeg");
  });

  it("ไม่แปลง PDF", async () => {
    const pdf = Buffer.from("%PDF-1.4 dummy");
    const out = await prepareImageForClassification(pdf, "application/pdf");
    expect(out.data).toBe(pdf);
    expect(out.mime).toBe("application/pdf");
  });
});
