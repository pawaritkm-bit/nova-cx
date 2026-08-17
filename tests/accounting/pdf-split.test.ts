import { describe, it, expect, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

import { splitPdfIntoChunks, extractPdfMaybeSplit } from "@/lib/accounting/pdf-split";

/**
 * pdf-split — ตัด PDF ใหญ่เป็นชิ้นอ่านทีละชิ้น (แก้ปัญหาไฟล์ใหญ่อ่านไม่ได้)
 *   ★ split path จริง (>24MB) ทดสอบผ่าน splitPdfIntoChunks ด้วย target เล็ก (ไม่ต้องสร้างไฟล์ 24MB)
 */
async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([300, 300]);
  return doc.save();
}

describe("splitPdfIntoChunks", () => {
  it("ไฟล์อยู่ในเพดาน → ชิ้นเดียว", async () => {
    const pdf = await makePdf(3);
    const chunks = await splitPdfIntoChunks(pdf, 10 * 1024 * 1024);
    expect(chunks.length).toBe(1);
  });

  it("target เล็กมาก → ตัดหลายชิ้น + เก็บครบทุกหน้า (ไม่ตัดทิ้ง)", async () => {
    const pdf = await makePdf(4);
    const chunks = await splitPdfIntoChunks(pdf, 1); // บังคับตัดทุกหน้า
    expect(chunks.length).toBeGreaterThan(1);
    let totalPages = 0;
    for (const c of chunks) {
      totalPages += (await PDFDocument.load(c)).getPageCount();
    }
    expect(totalPages).toBe(4);
  });
});

describe("extractPdfMaybeSplit — routing", () => {
  it("ไม่ใช่ PDF → เรียก extractChunk ครั้งเดียว (ไม่ split)", async () => {
    const fn = vi.fn(async () => [1, 2]);
    const out = await extractPdfMaybeSplit(Buffer.from("x"), "image/jpeg", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out).toEqual([1, 2]);
  });

  it("PDF เล็กกว่าเพดาน → เรียกครั้งเดียว (path เดิม)", async () => {
    const pdf = Buffer.from(await makePdf(2));
    const fn = vi.fn(async () => ["a"]);
    const out = await extractPdfMaybeSplit(pdf, "application/pdf", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out).toEqual(["a"]);
  });
});
