/**
 * วิธีจ่าย/รับเงิน ต่อบิล → "บัญชีคู่ (เครดิต)" สำหรับ double-entry — helper pure (เทสต์ได้)
 *
 * บริบท: หน้าลงบันทึกบัญชีเก็บ "ฝั่งเดบิต" (บัญชีค่าใช้จ่าย/สินทรัพย์ + VAT + หัก) อยู่แล้ว.
 *   เพื่อออกงบ (double-entry) ต้องรู้ "บัญชีคู่ฝั่งเครดิต" ด้วย — คำนวณจากวิธีจ่าย/รับเงิน:
 *     - เงินสด (cash)     → 1010 เงินสด
 *     - เช็ค   (cheque)   → ขาย=1155 เช็ครับล่วงหน้า · ซื้อ=2220 เช็คสั่งจ่ายล่วงหน้า
 *     - เงินโอน (transfer) → บัญชีเงินฝากที่ผูกไว้ (ถ้ามี) มิฉะนั้น default 1020 เงินฝากธนาคาร
 *     - ลูกหนี้/เจ้าหนี้ (credit) → ขาย=1140 ลูกหนี้การค้า · ซื้อ=2010 เจ้าหนี้การค้า
 *
 * ★ ทั้งหมดเป็น pure function (ไม่แตะ DB/network) — ใช้ทั้งฝั่ง worker (เดา), UI (hint), และเทสต์
 * ★ ค่าที่ worker เซ็ต = "ค่าแนะนำ ไม่ล็อก" — นักบัญชีแก้ได้เสมอ
 */
import type { ChartByCode } from "@/lib/accounting/chart-of-accounts";
import type { EntryType } from "@/lib/accounting/queries";

/** วิธีจ่าย/รับเงิน (null = ยังไม่ระบุ) */
export type PaymentMethod = "cash" | "cheque" | "transfer" | "credit";

/**
 * ป้ายภาษาไทยแบบกลาง ๆ (ยังไม่ระบุประเภทบิล) — ใช้ใน dropdown ตอน unspecified/สรุปรวม
 *   ★ credit เปลี่ยนตามฝั่ง (ขาย=ลูกหนี้ / ซื้อ=เจ้าหนี้) → ใช้ paymentMethodLabel() แทนเมื่อรู้ประเภท
 */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "เงินสด",
  cheque: "เช็ค",
  transfer: "เงินโอน",
  credit: "ลูกหนี้/เจ้าหนี้",
};

/**
 * ป้ายวิธีจ่าย/รับเงินตาม "ฝั่งบิล" (ขาย/ซื้อ) — credit สลับ ลูกหนี้↔เจ้าหนี้
 *   - sale:     credit → "ลูกหนี้"
 *   - purchase: credit → "เจ้าหนี้"
 *   - unspecified/อื่น: credit → "ลูกหนี้/เจ้าหนี้" (กลาง ๆ)
 */
export function paymentMethodLabel(method: PaymentMethod, entryType: EntryType): string {
  if (method === "credit") {
    if (entryType === "sale") return "ลูกหนี้";
    if (entryType === "purchase") return "เจ้าหนี้";
    return "ลูกหนี้/เจ้าหนี้";
  }
  return PAYMENT_METHOD_LABELS[method];
}

/** cast ค่าใด ๆ → PaymentMethod | null (validate ฝั่ง server กันค่าปลอมจาก client) */
export function asPaymentMethod(v: unknown): PaymentMethod | null {
  return v === "cash" || v === "cheque" || v === "transfer" || v === "credit" ? v : null;
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

/** ชื่อบัญชีจากผัง (fallback = ชื่อที่ส่งมา) */
function chartName(chartByCode: ChartByCode, code: string, fallback: string): string {
  return chartByCode[code]?.name ?? fallback;
}

/**
 * config บัญชีคู่ (เครดิต/เดบิต) ต่อวิธีจ่าย/รับเงิน — แก้ง่ายจุดเดียว
 *   - วิธีที่ขึ้นกับฝั่งบิล (cheque/credit) เก็บเป็น {sale, purchase}
 *   - transferDefault = ใช้เมื่อ "โอน" แต่ไม่ได้ผูกบัญชีธนาคารเฉพาะ (fallback)
 */
const CONTRA_CONFIG = {
  cash: { code: "1010", name: "เงินสด" },
  cheque: {
    sale: { code: "1155", name: "เช็ครับล่วงหน้า" },
    purchase: { code: "2220", name: "เช็คสั่งจ่ายล่วงหน้า" },
  },
  credit: {
    sale: { code: "1140", name: "ลูกหนี้การค้า" },
    purchase: { code: "2010", name: "เจ้าหนี้การค้า" },
  },
  transferDefault: { code: "1020", name: "เงินฝากธนาคาร" },
} as const;

/** บัญชีคู่ของวิธีที่ขึ้นกับฝั่ง (cheque/credit) — sale/purchase เท่านั้น, unspecified = null */
function sideAccount(
  chartByCode: ChartByCode,
  cfg: { sale: { code: string; name: string }; purchase: { code: string; name: string } },
  entryType: EntryType
): ContraAccount | null {
  if (entryType === "sale") return { code: cfg.sale.code, name: chartName(chartByCode, cfg.sale.code, cfg.sale.name) };
  if (entryType === "purchase") return { code: cfg.purchase.code, name: chartName(chartByCode, cfg.purchase.code, cfg.purchase.name) };
  return null; // unspecified — ยังตัดสินฝั่งไม่ได้
}

/**
 * บัญชีคู่ (เครดิต) ที่จะตั้งให้ตามวิธีจ่าย/รับเงิน — pure, เทสต์ได้
 *   - cash                → 1010 เงินสด
 *   - cheque + sale       → 1155 เช็ครับล่วงหน้า · cheque + purchase → 2220 เช็คสั่งจ่ายล่วงหน้า
 *   - transfer            → bankAccountCode ถ้ามี · ไม่มี = default 1020 เงินฝากธนาคาร
 *   - credit + purchase   → 2010 เจ้าหนี้การค้า · credit + sale → 1140 ลูกหนี้การค้า
 *   - cheque/credit + unspecified → null (ยังตัดสินฝั่งไม่ได้)
 *   @param chartByCode ผังบัญชีของ tenant (map รหัส→บัญชี) — ไม่มี default (ผู้เรียกต้องส่งเสมอ
 *     เพื่อให้ TS ฟ้อง caller ที่ยังไม่ threading chart — กันตกหล่นตามแผน)
 *   @returns {code,name} หรือ null ถ้าคำนวณไม่ได้ (ยังขาดข้อมูล)
 */
export function contraAccountFor(
  chartByCode: ChartByCode,
  paymentMethod: PaymentMethod | null,
  entryType: EntryType,
  bankAccountCode?: string | null
): ContraAccount | null {
  switch (paymentMethod) {
    case "cash":
      return {
        code: CONTRA_CONFIG.cash.code,
        name: chartName(chartByCode, CONTRA_CONFIG.cash.code, CONTRA_CONFIG.cash.name),
      };
    case "cheque":
      return sideAccount(chartByCode, CONTRA_CONFIG.cheque, entryType);
    case "transfer": {
      // ผูกบัญชีธนาคารเฉพาะไว้ (ข้อมูลเดิม) → ใช้รหัสนั้น · ไม่มี = default 1020
      const code = (bankAccountCode ?? "").trim() || CONTRA_CONFIG.transferDefault.code;
      return { code, name: chartName(chartByCode, code, CONTRA_CONFIG.transferDefault.name) };
    }
    case "credit":
      return sideAccount(chartByCode, CONTRA_CONFIG.credit, entryType);
    default:
      return null;
  }
}
