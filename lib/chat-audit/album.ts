/**
 * Album (อัลบั้มบิล) — pure helper สำหรับ "สโคปนักบัญชี" + "สร้างชื่อไฟล์ ASCII" ตอนดาวน์โหลด
 *
 * แยกออกมาเป็น pure function เพื่อ:
 *   - เทสต์ได้โดยไม่พึ่ง Supabase/DOM/JSZip
 *   - หน้า server (สโคป) + client component (ดาวน์โหลด) เรียกใช้ตรรกะเดียวกัน
 *
 * ★ PDPA: ชื่อไฟล์ดาวน์โหลด "ASCII-safe" ใช้ customer_code + วันที่ + ลำดับ เท่านั้น
 *   ห้ามใส่ชื่อลูกค้า/อักขระไทยในชื่อไฟล์ (กันข้อมูลอ่อนไหวหลุด + อักขระเพี้ยนข้ามระบบ)
 * ★ ไม่มี dependency ภายนอก / ไม่ log อะไร
 */
import type { BillItem } from "@/lib/chat-audit/bills";

/**
 * สโคปบิลตามสิทธิ์ผู้เรียก (บังคับ server-side — ห้ามเชื่อ client)
 *   - allowed = null (admin/executive): เห็นทุกบิล (รวมบิลที่ยังไม่จับคู่ลูกค้า)
 *   - allowed = Set (นักบัญชี/หัวหน้า): เห็นเฉพาะบิลของลูกค้าที่ตัวเองดูแล
 *     (customerId ต้องไม่ null และอยู่ในชุด — บิลยังไม่จับคู่ = ไม่เห็น)
 *   ★ ตรรกะเดียวกับ customerInScope ใน lib/accounting/access.ts
 */
export function scopeBillsByAccess(
  bills: BillItem[],
  allowed: Set<string> | null
): BillItem[] {
  if (allowed === null) return bills;
  return bills.filter((b) => b.customerId !== null && allowed.has(b.customerId));
}

/**
 * ทำให้เป็น ASCII ปลอดภัยสำหรับชื่อไฟล์ (เก็บเฉพาะ a-z A-Z 0-9 . _ -)
 *   ค่าว่าง/มีแต่อักขระต้องห้าม → คืน fallback
 */
export function safeAscii(s: string | null | undefined, fallback: string): string {
  const cleaned = (s ?? "").replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned || fallback;
}

/** ISO date → "YYYY-MM-DD" (UTC) — parse ไม่ได้/ว่าง คืน "nodate" */
export function dateStamp(iso: string | null | undefined): string {
  if (!iso) return "nodate";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "nodate";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * นามสกุลไฟล์ ASCII (เดาจาก original_name ก่อน แล้ว objectPath)
 *   - เจอ .xxx ท้ายชื่อ → ใช้ค่านั้น (lowercase)
 *   - ไม่เจอ → รูป='jpg' · ไฟล์อื่น='bin'
 */
export function fileExt(
  name: string | null | undefined,
  objectPath: string | null | undefined,
  isImage: boolean
): string {
  const src = (name || objectPath || "").toLowerCase();
  const m = src.match(/\.([a-z0-9]{1,8})$/);
  if (m) return m[1];
  return isImage ? "jpg" : "bin";
}

/**
 * ชื่อไฟล์บิลตอนดาวน์โหลด = "{code}_{YYYY-MM-DD}_{NN}.{ext}" (ASCII ล้วน)
 *   - code ไม่มี/ไม่ ASCII → "NA"
 *   - idx: ลำดับในชุด (เริ่ม 1) เติม 0 เป็น 2 หลัก
 *   ★ ไม่มีชื่อลูกค้า/ไทย (PDPA) — ปลอดภัยข้ามระบบปฏิบัติการ
 */
export function billDownloadName(
  code: string | null | undefined,
  billDate: string,
  idx: number,
  ext: string
): string {
  const c = safeAscii(code, "NA");
  const d = dateStamp(billDate);
  const n = String(Math.max(1, Math.floor(idx))).padStart(2, "0");
  const e = safeAscii(ext, "jpg").toLowerCase();
  return `${c}_${d}_${n}.${e}`;
}

/** ชื่อไฟล์ zip ของลูกค้าหนึ่งราย = "{code}_bills.zip" (ASCII) */
export function zipName(code: string | null | undefined): string {
  return `${safeAscii(code, "NA")}_bills.zip`;
}

/**
 * ต่อ query `download=<filename>` ให้ signed URL — Supabase จะตั้ง Content-Disposition
 * ให้เบราว์เซอร์ "บันทึกไฟล์" พร้อมชื่อที่กำหนด (แทนการเปิดดูในแท็บ)
 *   ★ filename เข้ารหัส URL แล้ว (กันอักขระพิเศษเพี้ยน)
 */
export function withDownloadParam(url: string, filename: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}download=${encodeURIComponent(filename)}`;
}
