/**
 * จับคู่ "สลิปโอนเงิน" ↔ "บิลเชื่อค้างชำระ" — ★ 2026-09-04 ผู้ใช้อนุมัติ ("ทำจริง"):
 *   "ลูกหนี้ คือบิลที่ไม่มีสลิปโอนเงินที่ลูกค้าโอนมาแล้วมาจับคู่ ·
 *    เจ้าหนี้ คือบิลที่ไม่มีสลิปโอนไปชำระมาจับคู่"
 *
 *   - สลิปเงินเข้า (ฝั่งขาย):  ชื่อ "ผู้โอน" ↔ ชื่อลูกค้าในบิลขายเชื่อค้าง → รับชำระ Dr เงิน / Cr ลูกหนี้
 *   - สลิปเงินออก (ฝั่งซื้อ):  ชื่อ "ผู้รับโอน" ↔ ชื่อผู้ขายในบิลซื้อเชื่อค้าง → จ่ายชำระ Dr เจ้าหนี้ / Cr เงิน
 *
 * ★ pure ล้วน — unit test ได้เต็ม · PDPA: ไม่ log ชื่อ/ตัวเลข
 */
import { round2 } from "@/lib/accounting/queries";
import { EPSILON } from "@/lib/accounting/statement-config";

/** บิลเชื่อค้างชำระ 1 ใบ (คำนวณ outstanding มาแล้วจาก billOutstanding) */
export type OutstandingBillLite = {
  entryId: string;
  docNo: string | null;
  docDate: string | null;
  counterpartyName: string | null;
  outstanding: number;
};

export type SlipMatch = OutstandingBillLite & {
  /** ยอดสลิปตรงกับยอดค้างพอดี (มั่นใจสูงสุด) */
  amountExact: boolean;
};

/** คำนำหน้า/รูปแบบนิติบุคคล/คำนำหน้าชื่อ ที่ตัดทิ้งก่อนเทียบชื่อ */
const NAME_NOISE = [
  "บริษัทจำกัด(มหาชน)", "บริษัทมหาชนจำกัด", "บริษัทจำกัด", "บริษัท", "จำกัด(มหาชน)", "จำกัด",
  "หจก.", "ห้างหุ้นส่วนจำกัด", "ห้างหุ้นส่วนสามัญ", "บจก.", "บมจ.", "บจ.", "ร้าน",
  "นางสาว", "น.ส.", "นาง", "นาย", "ด.ช.", "ด.ญ.", "คุณ", "ว่าที่ร.ต.", "ว่าที่ ร.ต.",
  "co.,ltd.", "co.,ltd", "co ltd", "company limited", "limited", "ltd.", "ltd", "inc.", "inc",
  "mr.", "mrs.", "miss", "ms.", "mr", "ms",
];

/**
 * normalize ชื่อสำหรับเทียบ: ตัดคำนำหน้า/รูปแบบนิติบุคคล + ช่องว่าง/จุด/วงเล็บ + lower
 *   "บจก. นีเวียโคขุน ฮาลาล (สำนักงานใหญ่)" → "นีเวียโคขุนฮาลาล"
 *   "MR IYARAT ADIREK" → "iyaratadirek"
 */
export function normalizeNameForMatch(name: string | null | undefined): string {
  let s = (name ?? "").toLowerCase().trim();
  if (!s) return "";
  // ตัดวงเล็บทั้งก้อน (สาขา/สำนักงานใหญ่)
  s = s.replace(/\([^)]*\)/g, " ");
  for (const noise of NAME_NOISE) s = s.split(noise.toLowerCase()).join(" ");
  // เหลือเฉพาะตัวอักษร/ตัวเลข (ตัดช่องว่าง จุด ขีด สัญลักษณ์)
  return s.replace(/[^0-9a-z฀-๿]/g, "");
}

/** ชื่อสองฝั่ง "ถือว่าเป็นคนเดียวกัน" ไหม — เท่ากัน หรือฝ่ายหนึ่งเป็น substring ของอีกฝ่าย (≥ 4 ตัวอักษร)
 *  (สลิปมักย่อ เช่น "นีเวียโคขุน" vs บิล "บจก. นีเวียโคขุน ฮาลาล") */
export function namesLooselyMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeNameForMatch(a);
  const nb = normalizeNameForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const short = na.length <= nb.length ? na : nb;
  const long = na.length <= nb.length ? nb : na;
  if (short.length < 4) return false; // สั้นเกิน เดาไม่ได้ (กันจับมั่ว)
  return long.includes(short);
}

/**
 * หาใบเชื่อค้างที่เข้าคู่กับสลิป — กรองด้วยชื่อก่อน แล้วเรียง: ยอดตรงเป๊ะก่อน → ใบเก่าก่อน (FIFO)
 *   คืน [] = ไม่มีคู่ (การ์ดจะลงรายได้/ค่าใช้จ่ายตามปกติ)
 */
export function matchSlipToOutstanding(
  slipCounterpartyName: string | null | undefined,
  slipNet: number,
  candidates: OutstandingBillLite[]
): SlipMatch[] {
  const net = round2(slipNet);
  const hits = candidates
    .filter((c) => c.outstanding > EPSILON && namesLooselyMatch(slipCounterpartyName, c.counterpartyName))
    .map((c) => ({ ...c, amountExact: Math.abs(round2(c.outstanding) - net) < EPSILON }));
  hits.sort((x, y) => {
    if (x.amountExact !== y.amountExact) return x.amountExact ? -1 : 1;
    return (x.docDate ?? "9999").localeCompare(y.docDate ?? "9999"); // ใบเก่าก่อน
  });
  return hits;
}
