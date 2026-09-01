/**
 * statement-bill-match.ts — กระทบรายการสเตทเมนต์กับบิลในระบบ (requirement 2026-09-01)
 *   เงินเข้า ↔ บิลขาย · เงินออก ↔ บิลซื้อ/สลิปจ่าย (รวม "รอระบุ" ทั้งสองทาง)
 *   เกณฑ์: ยอดตรง (เต็มบิล หรือยอดหลังหัก ณ ที่จ่าย) + วันที่ใกล้กัน + ชื่อผู้โอนตรงคู่ค้า (boost)
 *   1 บิลจับได้ 1 รายการ (greedy — เลือกคู่ที่ชื่อตรง > วันใกล้สุด)
 *
 * ★ pure function ทั้งไฟล์ (ไม่มี I/O) — มี unit test ประกบใน tests/accounting/statement-bill-match.test.ts
 */

export type BillForMatch = {
  id: string;
  docNo: string | null;
  docDate: string | null; // YYYY-MM-DD
  entryType: "purchase" | "sale" | "unspecified";
  status: string; // draft | confirmed
  /** ชื่อคู่ค้าฝั่งบิล (ขาย = ผู้ซื้อ · ซื้อ = ผู้ขาย) */
  counterparty: string | null;
  /** ยอดเต็มบิล (ก่อนหัก ณ ที่จ่าย) */
  totalGross: number;
  /** ยอดเงินจริงที่วิ่งผ่านธนาคาร (หลังหัก ณ ที่จ่าย) */
  totalNet: number;
  /** ลิงก์ดูไฟล์บิล (signed URL หมดอายุได้ — refresh ด้วยการกระทบใหม่) · null = บิลไม่มีไฟล์แนบ */
  uploadUrl?: string | null;
  /** ไฟล์แนบเป็นรูป (โชว์ thumbnail ได้) — false = PDF/ไฟล์อื่น (ให้ลิงก์เปิดดูแทน) */
  uploadIsImage?: boolean;
};

export type TxnForMatch = {
  date: string | null;
  amount: number | null;
  direction: "in" | "out" | null;
  counterparty_name: string | null;
};

export type BillMatch = {
  billId: string;
  docNo: string | null;
  docDate: string | null;
  entryType: "purchase" | "sale" | "unspecified";
  status: string;
  counterparty: string | null;
  daysApart: number;
  /** ชื่อผู้โอนในสเตทเมนต์ตรงกับคู่ค้าในบิล */
  nameHit: boolean;
};

/** ระยะวันสูงสุดที่ยังถือว่า "บิลเดียวกัน" (โอนช้ากว่าวันที่บิลได้บ้าง) */
export const MAX_DAYS_APART = 14;
/** ค่าเผื่อเทียบยอด (สตางค์ปัดเศษ) */
const AMOUNT_EPS = 0.005;

/** normalize ชื่อเทียบกัน: ตัดคำนำหน้า/ช่องว่าง/ตัวพิมพ์ — คืน "" ถ้าสั้นเกินเทียบ */
export function normalizeNameForMatch(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw
    .toLowerCase()
    .replace(/บริษัท|จำกัด|\(มหาชน\)|หจก\.?|ห้างหุ้นส่วนจำกัด|บจก?\.?|บมจ\.?/g, " ")
    .replace(/นางสาว|นาง|นาย|น\.ส\.|ด\.ญ\.|ด\.ช\.|ว่าที่\s*ร\.ต\.(?:หญิง)?|mr\.?|mrs\.?|miss|ms\.?/g, " ")
    .replace(/[^0-9a-zก-๙]/g, "");
  return s.length >= 4 ? s : "";
}

/** ชื่อสองฝั่ง "ตรงกัน" ไหม — ฝั่งหนึ่ง contain อีกฝั่ง (ชื่อสเตทเมนต์มักโดนตัดท้ายด้วยความกว้างคอลัมน์) */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeNameForMatch(a);
  const nb = normalizeNameForMatch(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.abs(Math.round((ta - tb) / 86400000));
}

function typeCompatible(dir: "in" | "out", t: BillForMatch["entryType"]): boolean {
  return t === "unspecified" || (dir === "in" ? t === "sale" : t === "purchase");
}

/**
 * จับคู่ txns ↔ bills — คืน array ยาวเท่า txns (null = ไม่พบบิลที่เข้าเกณฑ์)
 *   ลำดับการเลือกต่อรายการ: ชื่อตรง > วันใกล้สุด > บิลยืนยันแล้วก่อนร่าง · บิลถูกใช้แล้วไม่ถูกใช้ซ้ำ
 */
export function matchTxnsWithBills(txns: TxnForMatch[], bills: BillForMatch[]): (BillMatch | null)[] {
  const used = new Set<string>();
  return txns.map((t) => {
    if (!t.date || t.amount == null || !(t.amount > 0) || (t.direction !== "in" && t.direction !== "out")) return null;
    const dir = t.direction;
    let best: { bill: BillForMatch; daysApart: number; nameHit: boolean } | null = null;
    for (const b of bills) {
      if (used.has(b.id)) continue;
      if (!typeCompatible(dir, b.entryType)) continue;
      const amountOk =
        Math.abs(b.totalNet - t.amount) < AMOUNT_EPS || Math.abs(b.totalGross - t.amount) < AMOUNT_EPS;
      if (!amountOk) continue;
      const daysApart = b.docDate ? daysBetween(t.date, b.docDate) : null;
      if (daysApart == null || daysApart > MAX_DAYS_APART) continue;
      const nameHit = namesMatch(t.counterparty_name, b.counterparty);
      if (
        !best ||
        (nameHit && !best.nameHit) ||
        (nameHit === best.nameHit &&
          (daysApart < best.daysApart ||
            (daysApart === best.daysApart && b.status === "confirmed" && best.bill.status !== "confirmed")))
      ) {
        best = { bill: b, daysApart, nameHit };
      }
    }
    if (!best) return null;
    used.add(best.bill.id);
    return {
      billId: best.bill.id,
      docNo: best.bill.docNo,
      docDate: best.bill.docDate,
      entryType: best.bill.entryType,
      status: best.bill.status,
      counterparty: best.bill.counterparty,
      daysApart: best.daysApart,
      nameHit: best.nameHit,
    };
  });
}
