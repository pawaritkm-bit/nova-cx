/**
 * ตรวจ/แปลงคะแนนรวมที่หัวหน้าปรับ (action='edit') — ★ H1 (Phase 5a review)
 *   ★ ต้อง reject "ช่องว่าง" ก่อน Number() เสมอ — Number("")=0 จะลอดเป็นคะแนน 0 เงียบ ๆ
 *   ใช้ร่วมทั้งฝั่ง client (ReviewActions) และ API route เพื่อความสอดคล้อง
 */

/** true เมื่อเป็นตัวเลขจริงในช่วง 0–100 (null/undefined/NaN/นอกช่วง = false) */
export function isValidOverallScore(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
}

/**
 * แปลงคะแนนที่กรอก (string) → number ที่ผ่านเกณฑ์ หรือ null ถ้าไม่ผ่าน
 *   - ช่องว่าง / เว้นวรรคล้วน → null (★ กัน Number("")=0)
 *   - ไม่ใช่ตัวเลข / นอกช่วง 0–100 → null
 */
export function parseEditScore(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return isValidOverallScore(n) ? n : null;
}
