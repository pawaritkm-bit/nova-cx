import { describe, it, expect } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  extOf,
  classifyUpload,
  validateUpload,
  sanitizeUploadName,
} from "@/lib/accounting/upload";

/**
 * lib/accounting/upload — validate ไฟล์ที่นักบัญชี "อัปเอง" เข้าบัญชี
 *   ครอบ: จำแนกชนิด (รูป/PDF/Excel/CSV), จำกัดชนิด+ขนาด, sanitize ชื่อ ASCII
 */

describe("extOf", () => {
  it("ดึงนามสกุล lower-case", () => {
    expect(extOf("ใบกำกับ.PDF")).toBe("pdf");
    expect(extOf("report.final.xlsx")).toBe("xlsx");
    expect(extOf("noext")).toBe("");
    expect(extOf("")).toBe("");
  });
});

describe("classifyUpload", () => {
  it("รูป: image/* → image", () => {
    expect(classifyUpload("image/jpeg", "a.jpg")).toBe("image");
    expect(classifyUpload("image/png", "a.png")).toBe("image");
  });
  it("PDF → pdf", () => {
    expect(classifyUpload("application/pdf", "a.pdf")).toBe("pdf");
  });
  it("Excel: xlsx/xls → excel", () => {
    expect(
      classifyUpload("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx")
    ).toBe("excel");
    expect(classifyUpload("application/vnd.ms-excel", "a.xls")).toBe("excel");
  });
  it("CSV → csv (เช็ค csv ก่อน ms-excel)", () => {
    expect(classifyUpload("text/csv", "a.csv")).toBe("csv");
    // browser บางตัวส่ง application/vnd.ms-excel ให้ .csv → นามสกุล .csv ควรชนะเป็น csv
    expect(classifyUpload("application/vnd.ms-excel", "a.csv")).toBe("csv");
  });
  it("MIME ไม่ช่วย (octet-stream/ว่าง) → เดาจากนามสกุล", () => {
    expect(classifyUpload("application/octet-stream", "doc.pdf")).toBe("pdf");
    expect(classifyUpload("", "sheet.xlsx")).toBe("excel");
    expect(classifyUpload("", "data.csv")).toBe("csv");
  });
  it("ชนิดที่ไม่รองรับ → null", () => {
    expect(classifyUpload("application/zip", "a.zip")).toBeNull();
    expect(classifyUpload("video/mp4", "a.mp4")).toBeNull();
    expect(classifyUpload("", "a.exe")).toBeNull();
  });
});

describe("validateUpload", () => {
  it("รูป jpg ขนาดปกติ → ok kind=image", () => {
    expect(validateUpload({ mime: "image/jpeg", name: "bill.jpg", size: 1000 })).toEqual({
      ok: true,
      kind: "image",
    });
  });
  it("ไม่มีชื่อไฟล์ → error", () => {
    expect(validateUpload({ mime: "image/jpeg", name: "  ", size: 100 })).toEqual({
      ok: false,
      error: "ไม่พบไฟล์ที่เลือก",
    });
  });
  it("ไฟล์ว่าง (size 0) → error", () => {
    const r = validateUpload({ mime: "application/pdf", name: "a.pdf", size: 0 });
    expect(r.ok).toBe(false);
  });
  it("ใหญ่เกิน 50MB → error", () => {
    const r = validateUpload({ mime: "application/pdf", name: "a.pdf", size: MAX_UPLOAD_BYTES + 1 });
    expect(r).toEqual({ ok: false, error: "ไฟล์ใหญ่เกิน 50MB" });
  });
  it("พอดี 50MB → ok", () => {
    const r = validateUpload({ mime: "application/pdf", name: "a.pdf", size: MAX_UPLOAD_BYTES });
    expect(r.ok).toBe(true);
  });
  it("ชนิดไม่รองรับ (zip) → error ไทย", () => {
    const r = validateUpload({ mime: "application/zip", name: "a.zip", size: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("รองรับเฉพาะ");
  });
});

describe("sanitizeUploadName", () => {
  it("อักขระไทย/ช่องว่าง → _ (ASCII ล้วน) + คงส่วน ASCII/นามสกุล", () => {
    const s = sanitizeUploadName("Invoice ภาษี.pdf");
    expect(/^[A-Za-z0-9._-]+$/.test(s)).toBe(true);
    expect(s.startsWith("Invoice")).toBe(true);
    expect(s.endsWith(".pdf")).toBe(true);
  });
  it("ยุบ _ ซ้ำ + ตัดจุด/ขีดล่างนำหน้า", () => {
    expect(sanitizeUploadName("..a   b.csv")).toBe("a_b.csv");
  });
  it("เหลือแต่ไทย/สัญลักษณ์ (ไม่มี A-Za-z0-9) → '' (caller fallback)", () => {
    expect(sanitizeUploadName("ภาษาไทยล้วน")).toBe("");
    expect(sanitizeUploadName("")).toBe("");
  });
});
