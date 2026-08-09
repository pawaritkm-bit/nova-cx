/**
 * หนังสือรับรองหัก ณ ที่จ่าย (WHT Certificate) — pure helpers ล้วน
 *
 * บริบท: เฟส 3 ส่วน I (docs/06-accounting-features-roadmap.md, 0.2) — mirror pattern ของ
 *   `receipt-cert` (print-only, ไม่บันทึก DB, ไม่มี migration ใหม่)
 *
 * ★ ไฟล์นี้ pure ทั้งไฟล์ — ไม่แตะ DB, ไม่ import journal/ledger/statements ใด ๆ
 * ★ ออกได้เฉพาะบิลซื้อ (entryType==='purchase') ที่มีอย่างน้อย 1 บรรทัด whtAmount>0 (0.2):
 *   หนังสือรับรองออกโดย "ผู้จ่ายเงิน/ผู้มีหน้าที่หักภาษี" (ลูกค้าของสำนักงานเฉพาะตอนเป็นฝั่งซื้อ)
 *   บิลขายที่ whtAmount>0 คือลูกค้าเราถูกอีกฝั่งหัก (เป็นผู้รับใบรับรอง ไม่ใช่ผู้ออก) — ไม่ eligible
 */

/** ประเภทของ entry ที่ใช้ตัดสิน eligibility (ไม่ต้องรับ BillEntry เต็มรูป — Pick แค่ที่ใช้จริง) */
export type WhtCertEligibleEntry = {
  entryType: string;
  lines: { whtAmount: number }[];
};

/** true เฉพาะบิลซื้อที่มีอย่างน้อย 1 บรรทัดถูกหัก ณ ที่จ่าย (whtAmount > 0) */
export function isWhtCertEligible(entry: WhtCertEligibleEntry): boolean {
  return entry.entryType === "purchase" && entry.lines.some((l) => l.whtAmount > 0);
}

/** บรรทัดต้นทาง (bill_entry_line) ที่ใช้สร้างบรรทัดหนังสือรับรอง */
export type WhtCertSourceLine = {
  description: string | null;
  amount: number;
  whtRate: number;
  whtAmount: number;
};

/** 1 บรรทัดในหนังสือรับรองหัก ณ ที่จ่าย */
export type WhtCertLine = {
  /** วันที่จ่ายเงิน (dd/mm/พ.ศ. — ใช้วันเดียวกันทุกบรรทัดของบิลเดียวกัน = doc_date) */
  date: string;
  description: string;
  /** เงินได้ที่จ่าย (ก่อนหัก) */
  amount: number;
  /** อัตราภาษีที่หัก (%) */
  whtRate: number;
  /** ภาษีที่หักไว้ */
  whtAmount: number;
};

/**
 * สร้างบรรทัดหนังสือรับรองจากบรรทัดบิล — กรองเฉพาะ whtAmount > 0 (0.2)
 *   บิลเดียวมีได้หลายบรรทัด WHT พร้อมกันในเอกสารเดียว (ไม่แยกเอกสารต่อบรรทัด)
 * @param docDate วันที่บิล (dd/mm/พ.ศ.) — ใช้เป็นวันที่จ่ายของทุกบรรทัด (ค่าเริ่มต้น "" ถ้าไม่ส่งมา)
 */
export function buildWhtCertLines(lines: WhtCertSourceLine[], docDate = ""): WhtCertLine[] {
  return lines
    .filter((l) => l.whtAmount > 0)
    .map((l) => ({
      date: docDate,
      description: l.description ?? "",
      amount: l.amount,
      whtRate: l.whtRate,
      whtAmount: l.whtAmount,
    }));
}

/** ตัวเลือก "ประเภทเงินได้พึงประเมิน" (มาตรา 40) แบบย่อ — dropdown ในฟอร์มพิมพ์ ไม่ persist (0.2) */
export const WHT_INCOME_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "service", label: "ค่าจ้างทำของ/ค่าบริการ" },
  { value: "rent", label: "ค่าเช่า" },
  { value: "transport", label: "ค่าขนส่ง" },
  { value: "ads", label: "ค่าโฆษณา" },
  { value: "prize", label: "รางวัล/ส่วนลด/ของแถม" },
  { value: "other", label: "อื่น ๆ" },
];
