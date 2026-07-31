/**
 * ลงบันทึกบัญชี ภาษีซื้อ/ขาย — ตัวช่วยคำนวณ/ฟอร์แมต (pure, client-safe)
 *
 * ★ ใช้ได้ทั้งฝั่ง client (EntryEditor auto-คำนวณ) และ server — ไม่พึ่ง DB/network
 * ★ robust: parse ตัวเลขที่ผู้ใช้พิมพ์ (comma, ช่องว่าง, เลขไทย ๐-๙, วงเล็บ/ขีดลบ) → number
 * ★ VAT 7% + net = amount + vat - wht · ปัดทศนิยม 2 ตำแหน่งกัน floating error
 *   (สอดคล้องกับ lib/accounting/queries.ts:lineNet / actions-lib resolveWht ฝั่ง server)
 */

/** อัตรา VAT มาตรฐาน (7%) */
export const VAT_RATE = 7;

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";

/** ปัดทศนิยม 2 ตำแหน่ง (กัน floating error สะสม) — ตรงกับ round2 ใน queries.ts */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * แปลงข้อความที่ผู้ใช้พิมพ์เป็นตัวเลข (NaN-safe → 0)
 *   - รองรับ comma คั่นหลักพัน, ช่องว่าง, เลขไทย ๐-๙
 *   - เก็บเฉพาะ 0-9 . และเครื่องหมายลบนำหน้า (กันตัวอักษร/สัญลักษณ์แปลกปลอม)
 *   - หลาย "." → ใช้จุดแรกเป็นทศนิยม (กันพิมพ์เกิน)
 */
export function parseAmountInput(raw: string | number | null | undefined): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;

  // เลขไทย → อารบิก
  s = s.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
  // ตัด comma + ช่องว่างทุกชนิด
  s = s.replace(/[,\s ]/g, "");
  // เก็บเฉพาะตัวเลข จุด และลบ
  s = s.replace(/[^0-9.\-]/g, "");
  // ลบให้เหลือเฉพาะตัวนำหน้า
  const neg = s.startsWith("-");
  s = s.replace(/-/g, "");
  // จุดทศนิยม: เก็บจุดแรก รวมส่วนที่เหลือ
  const firstDot = s.indexOf(".");
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  }
  if (s === "" || s === ".") return 0;
  const n = Number((neg ? "-" : "") + s);
  return Number.isFinite(n) ? n : 0;
}

/** VAT ของ amount ตามประเภท (novat → 0) — ปัด 2 */
export function calcVat(amount: number, vatType: "vat" | "novat"): number {
  if (vatType === "novat") return 0;
  const a = Number.isFinite(amount) ? amount : 0;
  return round2((a * VAT_RATE) / 100);
}

/** หัก ณ ที่จ่าย = amount * rate/100 — ปัด 2 (rate ≤ 0 → 0) */
export function calcWht(amount: number, rate: number): number {
  const a = Number.isFinite(amount) ? amount : 0;
  const r = Number.isFinite(rate) && rate > 0 ? rate : 0;
  return r > 0 ? round2((a * r) / 100) : 0;
}

/** รวมจ่ายจริง = มูลค่า + VAT − หัก ณ ที่จ่าย — ปัด 2 */
export function calcNet(amount: number, vat: number, wht: number): number {
  return round2(
    (Number.isFinite(amount) ? amount : 0) +
      (Number.isFinite(vat) ? vat : 0) -
      (Number.isFinite(wht) ? wht : 0)
  );
}

/** ฟอร์แมตเงินแบบไทย: คั่นหลักพัน + ทศนิยม 2 ตำแหน่งเสมอ */
export function formatMoney(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
