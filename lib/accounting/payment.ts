/**
 * วิธีจ่าย/รับเงิน ต่อบิล → "บัญชีคู่ (เครดิต)" สำหรับ double-entry — helper pure (เทสต์ได้)
 *
 * บริบท: หน้าลงบันทึกบัญชีเก็บ "ฝั่งเดบิต" (บัญชีค่าใช้จ่าย/สินทรัพย์ + VAT + หัก) อยู่แล้ว.
 *   เพื่อออกงบ (double-entry) ต้องรู้ "บัญชีคู่ฝั่งเครดิต" ด้วย — คำนวณจากวิธีจ่าย/รับเงิน:
 *     - เงินสด (cash)    → 1010 เงินสด
 *     - โอน   (transfer) → บัญชีเงินฝากธนาคารที่เลือก (รหัส 1020/1025/1030 ต่อลูกค้า)
 *     - เชื่อ  (credit)   → ซื้อ=2010 เจ้าหนี้การค้า · ขาย=1140 ลูกหนี้การค้า
 *
 * ★ ทั้งหมดเป็น pure function (ไม่แตะ DB/network) — ใช้ทั้งฝั่ง worker (เดา), UI (hint), และเทสต์
 * ★ ค่าที่ worker เซ็ต = "ค่าแนะนำ ไม่ล็อก" — นักบัญชีแก้ได้เสมอ
 */
import { CHART_BY_CODE } from "@/lib/accounting/chart-of-accounts";
import type { EntryType } from "@/lib/accounting/queries";

/** วิธีจ่าย/รับเงิน (null = ยังไม่ระบุ) */
export type PaymentMethod = "cash" | "transfer" | "credit";

/** ป้ายภาษาไทยของวิธีจ่าย/รับเงิน (ใช้ใน dropdown/สรุป) */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "เงินสด",
  transfer: "โอน",
  credit: "เชื่อ",
};

/** cast ค่าใด ๆ → PaymentMethod | null (validate ฝั่ง server กันค่าปลอมจาก client) */
export function asPaymentMethod(v: unknown): PaymentMethod | null {
  return v === "cash" || v === "transfer" || v === "credit" ? v : null;
}

/**
 * เดา (suggestion) วิธีจ่าย/รับเงิน จาก doc_kind ที่ AI จำแนก (+ entryType เผื่ออนาคต)
 *   - cash / handwritten (บิลเงินสด/เขียนมือ) → 'cash'
 *   - slip (สลิปโอน)                         → 'transfer'
 *   - purchase / sale (ใบกำกับภาษี)          → 'credit' (ตั้งเป็นเจ้าหนี้/ลูกหนี้ก่อน)
 *   - อื่น ๆ / ไม่รู้                          → null (ให้คนเลือกเอง)
 *   ★ ค่าแนะนำเท่านั้น — นักบัญชีแก้ได้ (บิลเงินสดที่ออกใบกำกับก็มี)
 */
export function suggestPaymentMethod(
  docKind: string | null | undefined,
  _entryType?: EntryType
): PaymentMethod | null {
  const k = (docKind ?? "").trim().toLowerCase();
  switch (k) {
    case "cash":
    case "handwritten":
      return "cash";
    case "slip":
      return "transfer";
    case "purchase":
    case "sale":
      return "credit";
    default:
      return null;
  }
}

/** บัญชีคู่ (เครดิต) — {รหัส, ชื่อ} */
export type ContraAccount = { code: string; name: string };

/** ชื่อบัญชีจากผังกลาง (fallback = ชื่อที่ส่งมา) */
function chartName(code: string, fallback: string): string {
  return CHART_BY_CODE[code]?.name ?? fallback;
}

/**
 * บัญชีคู่ (เครดิต) ที่จะตั้งให้ตามวิธีจ่าย/รับเงิน — pure, เทสต์ได้
 *   - cash                → 1010 เงินสด
 *   - transfer            → บัญชีเงินฝากที่เลือก (bankAccountCode) · ไม่เลือก = code ว่าง (รอเลือก)
 *   - credit + purchase   → 2010 เจ้าหนี้การค้า
 *   - credit + sale       → 1140 ลูกหนี้การค้า
 *   - credit + unspecified/อื่น → null (ยังตัดสินฝั่งไม่ได้)
 *   @returns {code,name} หรือ null ถ้าคำนวณไม่ได้ (ยังขาดข้อมูล)
 */
export function contraAccountFor(
  paymentMethod: PaymentMethod | null,
  entryType: EntryType,
  bankAccountCode?: string | null
): ContraAccount | null {
  switch (paymentMethod) {
    case "cash":
      return { code: "1010", name: chartName("1010", "เงินสด") };
    case "transfer": {
      const code = (bankAccountCode ?? "").trim();
      if (!code) return { code: "", name: "เงินฝากธนาคาร (ยังไม่เลือกบัญชี)" };
      return { code, name: chartName(code, "เงินฝากธนาคาร") };
    }
    case "credit":
      if (entryType === "purchase") return { code: "2010", name: chartName("2010", "เจ้าหนี้การค้า") };
      if (entryType === "sale") return { code: "1140", name: chartName("1140", "ลูกหนี้การค้า") };
      return null; // unspecified — ยังไม่รู้ฝั่ง
    default:
      return null;
  }
}
