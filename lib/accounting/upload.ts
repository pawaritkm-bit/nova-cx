/**
 * อัปโหลดไฟล์เข้าบัญชีเอง (นักบัญชีแนบเอกสารที่ไม่ได้มาทางไลน์) — pure helpers
 *
 * ★ ใช้ทั้งฝั่ง server action (validate + สร้าง object path) และ client (accept/แสดงผล)
 * ★ ไม่มี dependency ภายนอก — รับ/คืน plain value เท่านั้น (ทดสอบได้)
 * ★ ความปลอดภัย: จำกัดชนิดไฟล์ (รูป/PDF/Excel/CSV) + ขนาด ≤ 50MB
 *   + sanitize ชื่อไฟล์เป็น ASCII (Supabase Storage key ไม่รับอักขระไทย → 400)
 */

/**
 * เพดานขนาดไฟล์ที่อัปได้ = 50MB
 *   ★ อัปตรงเข้า Supabase Storage (signed URL) เลยไม่ชนเพดาน Vercel 4.5MB แล้ว
 *   ★ 50MB = เพดาน global upload ของ Supabase project (ทดสอบแล้ว: 50MB ผ่าน / 80MB ไม่ผ่าน)
 *     ถ้าต้องการมากกว่านี้ ต้องขยาย global upload limit ใน Supabase dashboard + ใช้ resumable upload
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** ชนิดไฟล์ที่รองรับ (สำหรับตัดสินวิธีแสดง: image=inline, อื่น=ปุ่มเปิด/ดาวน์โหลด) */
export type UploadKind = "image" | "pdf" | "excel" | "csv";

/** map นามสกุล → ชนิด (fallback เมื่อ MIME ไม่น่าเชื่อถือ เช่น csv/xls จาก browser บางตัว) */
const EXT_KIND: Record<string, UploadKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  heif: "image",
  bmp: "image",
  pdf: "pdf",
  xlsx: "excel",
  xls: "excel",
  csv: "csv",
};

/** นามสกุล (lower, ไม่มีจุด) จากชื่อไฟล์ — คืน "" ถ้าไม่มี */
export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec((name ?? "").trim());
  return m ? m[1].toLowerCase() : "";
}

/**
 * จำแนกชนิดไฟล์จาก MIME ก่อน แล้ว fallback เป็นนามสกุล
 *   คืน null = ไม่รองรับ (ไม่ใช่ รูป/PDF/Excel/CSV)
 */
export function classifyUpload(mime: string, name: string): UploadKind | null {
  // ★ เชื่อ "นามสกุล" ก่อนเสมอ (แก้กำกวม ms-excel↔csv + MIME octet-stream/ว่างที่ไม่ช่วย)
  const ext = extOf(name);
  const extKind = EXT_KIND[ext];
  if (extKind) return extKind;
  // ไม่มีนามสกุลที่รู้จัก → ใช้ MIME
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.includes("pdf")) return "pdf";
  if (m.includes("csv")) return "csv";
  if (m.includes("spreadsheetml") || m.includes("ms-excel") || m.includes("excel")) return "excel";
  return null;
}

/** ผลตรวจไฟล์อัป */
export type UploadValidation = { ok: true; kind: UploadKind } | { ok: false; error: string };

/**
 * ตรวจไฟล์ที่อัป: ต้องมีชื่อ + ไม่ว่าง + ≤ 50MB + ชนิดที่รองรับ
 *   error เป็นข้อความไทยสุภาพ (โชว์ผู้ใช้ได้ตรง)
 */
export function validateUpload(params: { mime: string; name: string; size: number }): UploadValidation {
  const name = (params.name ?? "").trim();
  if (!name) return { ok: false, error: "ไม่พบไฟล์ที่เลือก" };
  if (!(params.size > 0)) return { ok: false, error: "ไฟล์ว่างเปล่า" };
  if (params.size > MAX_UPLOAD_BYTES) return { ok: false, error: "ไฟล์ใหญ่เกิน 50MB" };
  const kind = classifyUpload(params.mime, name);
  if (!kind) return { ok: false, error: "รองรับเฉพาะรูปภาพ, PDF, Excel (.xlsx/.xls) และ CSV" };
  return { ok: true, kind };
}

/**
 * sanitize ชื่อไฟล์เดิมให้เป็น ASCII-safe สำหรับ storage key
 *   เก็บเฉพาะ [A-Za-z0-9._-] · อักขระอื่น (ไทย/ช่องว่าง/`/`) → `_` แล้วยุบ `_` ซ้ำ + ตัดนำหน้า
 *   คืน "" ถ้าเหลือแต่จุด/ว่าง (caller ต้อง fallback เป็นชื่อ timestamp)
 */
export function sanitizeUploadName(raw: string): string {
  const cleaned = (raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._]+/, "");
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "";
}

/** accept ของ <input type="file"> — รูป/PDF/Excel/CSV */
export const UPLOAD_ACCEPT = "image/*,.pdf,.xlsx,.xls,.csv";
