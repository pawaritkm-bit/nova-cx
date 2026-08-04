/**
 * แปลงจำนวนเงินเป็น "ตัวอักษรภาษาไทย" (บาท/สตางค์) — pure, client-safe
 *
 * ★ ใช้ในใบรับรองแทนใบเสร็จ (แสดงยอดรวมเป็นตัวหนังสือ) + เอกสารบัญชีอื่น ๆ
 * ★ รองรับสตางค์ (ทศนิยม 2 ตำแหน่ง) — ปัดเศษด้วยการแปลงเป็นสตางค์จำนวนเต็มก่อน
 *   จึงเลี่ยง floating error (เช่น 0.29 → 29 สตางค์ ไม่ใช่ 28.999…)
 * ★ ไม่มี dependency ภายนอก/DB → นำไป unit test ได้ตรงไปตรงมา
 *
 * ตัวอย่าง:
 *   bahtText(1500)      → "หนึ่งพันห้าร้อยบาทถ้วน"
 *   bahtText(1234.5)    → "หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์"
 *   bahtText(21)        → "ยี่สิบเอ็ดบาทถ้วน"
 *   bahtText(0)         → "ศูนย์บาทถ้วน"
 */

const THAI_NUM = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
/** หลักตามตำแหน่ง (0=หน่วย ถึง 5=แสน) */
const THAI_UNIT = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

/**
 * อ่านจำนวนเต็ม 0–999,999 เป็นข้อความไทย (ไม่รวมคำว่า "ล้าน")
 *   - หลักสิบ: 1x = "สิบ…", 2x = "ยี่สิบ…"
 *   - หลักหน่วยที่เป็น 1 และมีหลักอื่นนำหน้า = "เอ็ด" (เช่น 11 = สิบเอ็ด, 21 = ยี่สิบเอ็ด)
 */
function readBelowMillion(n: number): string {
  if (n <= 0) return "";
  const s = String(n);
  const len = s.length;
  let result = "";
  for (let i = 0; i < len; i++) {
    const d = Number(s[i]);
    const pos = len - 1 - i; // ตำแหน่งหลักจากขวา (0=หน่วย)
    if (d === 0) continue;
    if (pos === 0 && d === 1 && len > 1) {
      result += "เอ็ด";
    } else if (pos === 1 && d === 1) {
      result += "สิบ";
    } else if (pos === 1 && d === 2) {
      result += "ยี่สิบ";
    } else {
      result += THAI_NUM[d] + THAI_UNIT[pos];
    }
  }
  return result;
}

/**
 * อ่านจำนวนเต็มบวก (รองรับหลัก "ล้าน" ซ้อนกัน) เป็นข้อความไทย
 *   n ≥ 1,000,000 → อ่านส่วน "ล้าน" แบบ recursive แล้วต่อด้วยเศษที่เหลือ
 */
function readInteger(n: number): string {
  if (n <= 0) return "";
  if (n < 1_000_000) return readBelowMillion(n);
  const head = Math.floor(n / 1_000_000);
  const tail = n % 1_000_000;
  let result = readInteger(head) + "ล้าน";
  if (tail > 0) result += readBelowMillion(tail);
  return result;
}

/**
 * แปลงจำนวนเงินเป็นข้อความไทย (บาท/สตางค์)
 *   - ค่าติดลบ → นำหน้าด้วย "ลบ"
 *   - ไม่มีเศษสตางค์ → ลงท้าย "ถ้วน"
 *   - NaN/Infinity → ถือเป็น 0 ("ศูนย์บาทถ้วน")
 */
export function bahtText(amount: number | null | undefined): string {
  const value = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  const negative = value < 0;

  // แปลงเป็น "สตางค์จำนวนเต็ม" ก่อน กัน floating error แล้วค่อยแยกบาท/สตางค์
  const totalSatang = Math.round((Math.abs(value) + Number.EPSILON) * 100);
  const baht = Math.floor(totalSatang / 100);
  const satang = totalSatang % 100;

  let text = "";
  if (baht > 0) text += readInteger(baht) + "บาท";
  if (satang > 0) {
    // มีเศษสตางค์ → ถ้าบาท=0 ให้อ่านเฉพาะสตางค์ (เช่น 0.25 = "ยี่สิบห้าสตางค์")
    text += readInteger(satang) + "สตางค์";
  } else {
    // ไม่มีเศษสตางค์ → ลงท้าย "บาทถ้วน" (บาท=0 ด้วย = "ศูนย์บาทถ้วน")
    text = (baht > 0 ? text : "ศูนย์บาท") + "ถ้วน";
  }

  return (negative ? "ลบ" : "") + text;
}
