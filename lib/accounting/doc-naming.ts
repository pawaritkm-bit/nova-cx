/**
 * doc-naming.ts — ตั้งชื่อ "ไฟล์เอกสาร" ตามชื่อบัญชี/ชื่อร้านจริง (ตามที่ลูกค้าต้องการ)
 *   โฟลเดอร์ = ตัวลูกค้า (ชื่อไลน์) · ไฟล์เอกสารข้างใน = ชื่อบัญชี (สเตทเมนต์) / ชื่อร้าน (รายงานแพลตฟอร์ม)
 */

/** อักขระที่ OneDrive/Windows ห้ามในชื่อไฟล์ → เว้นวรรค + ยุบช่องว่าง + จำกัดความยาว */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\/:*?"<>|\x00-\x1f\\]/g;
export function sanitizeDocName(raw: string | null | undefined): string {
  return (raw ?? "").replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * เดา "ชื่อร้าน" จากชื่อไฟล์รายงานแพลตฟอร์ม (เช่น LINEMAN/Shopee)
 *   "ยอดขายตามประเภทออเดอร์_เจนเบเกอรี่ 1_20251101–20260819.xlsx" → "เจนเบเกอรี่ 1"
 *   ตัดนามสกุล + ช่วงวันที่ท้าย + คำนำหน้าประเภทรายงาน · เดาไม่ได้ → null
 */
export function shopNameFromFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  let n = name.replace(/\.[^.]+$/, ""); // ตัดนามสกุล
  n = n.replace(/[_\s]*\d{6,8}\s*[–\-]\s*\d{6,8}.*$/, ""); // ตัดช่วงวันที่ท้าย (YYYYMMDD–YYYYMMDD)
  n = n.replace(/^(?:ยอดขาย\S*|ภาพรวม\S*|รายงาน\S*|สรุป\S*|report\S*|sales?\S*)[_\s]+/i, ""); // ตัดคำนำหน้าประเภท
  n = sanitizeDocName(n);
  return n.length >= 2 ? n : null;
}
