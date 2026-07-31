/**
 * ผังบัญชีมาตรฐานกลาง (ใช้ร่วมทุกลูกค้า) — ที่มา: ไฟล์ ผังบัญชี.xls ของเจ้าของระบบ
 *   ใช้เป็นตัวเลือก dropdown ในหน้าลงบันทึกบัญชี (เลือกบัญชีต่อบรรทัด)
 *   ★ รหัสบัญชี (code) = ล็อกเมื่อเลือกแล้ว ห้ามแก้ · ชื่อบัญชี (name) = แก้ได้ต่อบรรทัด
 *   หมวดตามเลขหลักแรก: 1 สินทรัพย์ · 2 หนี้สิน · 3 ทุน · 4 รายได้ · 5 ค่าใช้จ่าย · 6 อื่น ๆ
 *   ไฟล์นี้ auto-generate — แก้ผังให้แก้ที่แหล่งแล้ว regenerate
 */
export type ChartAccount = {
  code: string;
  name: string;
  category: string;
  /**
   * true = บัญชี "เงินฝากธนาคาร" ที่ต้องแยกต่อลูกค้า (เลขบัญชีเป็นของบริษัทเดียว)
   *   ★ ผังกลางเก็บชื่อ generic (#1/#2/#3) เท่านั้น — เลขบัญชีจริงอยู่ที่ customer_bank_accounts
   *     (กันข้อมูลเลขบัญชีหลุดข้ามบริษัท / PDPA). UI แทนหมวดนี้ด้วยบัญชีของลูกค้าเจ้าของบิล
   */
  bank?: boolean;
};

export const CHART_OF_ACCOUNTS: ChartAccount[] = [
  { code: "1010", name: "เงินสด", category: "สินทรัพย์" },
  { code: "1015", name: "เงินสดย่อย", category: "สินทรัพย์" },
  // ★ 3 บัญชีเงินฝากธนาคาร: ชื่อ generic + bank:true — เลขบัญชีจริงผูกต่อลูกค้า (customer_bank_accounts)
  { code: "1020", name: "เงินฝากธนาคาร #1", category: "สินทรัพย์", bank: true },
  { code: "1025", name: "เงินฝากธนาคาร #2", category: "สินทรัพย์", bank: true },
  { code: "1030", name: "เงินฝากธนาคาร #3", category: "สินทรัพย์", bank: true },
  { code: "1140", name: "ลูกหนี้การค้า", category: "สินทรัพย์" },
  { code: "1145", name: "สำรองหนี้สูญ", category: "สินทรัพย์" },
  { code: "1150", name: "ลูกหนี้อื่น ๆ", category: "สินทรัพย์" },
  { code: "1151", name: "ภาษีหัก ณ ที่จ่าย", category: "สินทรัพย์" },
  { code: "1154", name: "ภาษีซื้อ", category: "สินทรัพย์" },
  { code: "1155", name: "เช็ครับล่วงหน้า", category: "สินทรัพย์" },
  { code: "1156", name: "ลูกหนี้กรมสรรพากร", category: "สินทรัพย์" },
  { code: "1160", name: "บัตรเครดิต", category: "สินทรัพย์" },
  { code: "1210", name: "ค่าใช้จ่ายจ่ายล่วงหน้า", category: "สินทรัพย์" },
  { code: "1215", name: "รายได้ค้างรับ", category: "สินทรัพย์" },
  { code: "1216", name: "ภาษีถูกหัก ณ ที่จ่าย", category: "สินทรัพย์" },
  { code: "1220", name: "ภาษีซื้อที่ยังไม่ถึงกำหนด", category: "สินทรัพย์" },
  { code: "1510", name: "สินค้าสำเร็จรูป", category: "สินทรัพย์" },
  { code: "1610", name: "ที่ดิน", category: "สินทรัพย์" },
  { code: "1615", name: "อาคาร", category: "สินทรัพย์" },
  { code: "1615.1", name: "ค่าเสื่อมสะสม-อาคาร", category: "สินทรัพย์" },
  { code: "1640", name: "อุปกรณ์สำนักงาน", category: "สินทรัพย์" },
  { code: "1640.1", name: "ค่าเสื่อมสะสม-อุปกรณ์สำนักงาน", category: "สินทรัพย์" },
  { code: "1645", name: "รถยนต์", category: "สินทรัพย์" },
  { code: "1645.1", name: "ค่าเสื่อมสะสม-รถยนต์", category: "สินทรัพย์" },
  { code: "2010", name: "เจ้าหนี้การค้า", category: "หนี้สิน" },
  { code: "2015", name: "เจ้าหนี้อื่น ๆ", category: "หนี้สิน" },
  { code: "2035", name: "เงินปันผลค้างจ่าย", category: "หนี้สิน" },
  { code: "2040", name: "ค่าใช้จ่ายค้างจ่าย", category: "หนี้สิน" },
  { code: "2045", name: "ภาษีเงินได้ค้างจ่าย", category: "หนี้สิน" },
  { code: "2110", name: "หุ้นกู้", category: "หนี้สิน" },
  { code: "2210", name: "รายได้รับล่วงหน้า", category: "หนี้สิน" },
  { code: "2220", name: "เช็คสั่งจ่ายล่วงหน้า", category: "หนี้สิน" },
  { code: "2900", name: "ภาษีขาย", category: "หนี้สิน" },
  { code: "2910", name: "ภาษีหัก ณ ที่จ่าย", category: "หนี้สิน" },
  { code: "2920", name: "เจ้าหนี้สรรพากร", category: "หนี้สิน" },
  { code: "3010", name: "ทุนเรือนหุ้น", category: "ส่วนของผู้ถือหุ้น" },
  { code: "3020", name: "กำไรสะสม", category: "ส่วนของผู้ถือหุ้น" },
  { code: "4010", name: "ขายสินค้า", category: "รายได้" },
  { code: "4010.1", name: "รับคืนและส่วนลด", category: "รายได้" },
  { code: "4010.2", name: "ส่วนลดจ่าย", category: "รายได้" },
  { code: "4020", name: "รายได้อื่น ๆ", category: "รายได้" },
  { code: "4210", name: "ดอกเบี้ยเงินฝากธนาคาร", category: "รายได้" },
  { code: "5010", name: "ซื้อสินค้า", category: "ค่าใช้จ่าย" },
  { code: "5010.1", name: "ส่งคืนและส่วนลด", category: "ค่าใช้จ่าย" },
  { code: "5010.2", name: "ส่วนลดรับ", category: "ค่าใช้จ่าย" },
  { code: "5010.3", name: "ค่าขนส่งเมื่อซื้อ", category: "ค่าใช้จ่าย" },
  { code: "5310", name: "เงินเดือนพนักงาน", category: "ค่าใช้จ่าย" },
  { code: "5315", name: "ค่าโฆษณา", category: "ค่าใช้จ่าย" },
  { code: "5320", name: "ค่าไฟฟ้า", category: "ค่าใช้จ่าย" },
  { code: "5325", name: "ค่าน้ำประปา", category: "ค่าใช้จ่าย" },
  { code: "5330", name: "ค่าโทรศัพท์", category: "ค่าใช้จ่าย" },
  { code: "5335", name: "ค่าไปรษณีย์", category: "ค่าใช้จ่าย" },
  { code: "5336", name: "ค่าใช้จ่ายสำนักงาน", category: "ค่าใช้จ่าย" },
  { code: "5337", name: "ค่าบริการค่าขนส่ง", category: "ค่าใช้จ่าย" },
  { code: "5338", name: "ค่าอบรมหลักสูตรต่างๆ", category: "ค่าใช้จ่าย" },
  { code: "5340", name: "ค่าน้ำมัน", category: "ค่าใช้จ่าย" },
  { code: "5341", name: "ค่าขนส่ง", category: "ค่าใช้จ่าย" },
  { code: "5342", name: "ค่าบริการ", category: "ค่าใช้จ่าย" },
  { code: "5343", name: "ค่าบริการเครื่องถ่ายเอกสาร", category: "ค่าใช้จ่าย" },
  { code: "5344", name: "ค่าบริการแพลตฟอร์ม", category: "ค่าใช้จ่าย" },
  { code: "5345", name: "ค่าบำรุงรักษายานพาหนะ", category: "ค่าใช้จ่าย" },
  { code: "5350", name: "วัสดุอุปกรณ์สำนักงานสิ้นเปลือง", category: "ค่าใช้จ่าย" },
  { code: "5351", name: "ค่าปรับปรุงต่อเติมสำนักงาน", category: "ค่าใช้จ่าย" },
  { code: "5352", name: "ค่าซ่อมแซม", category: "ค่าใช้จ่าย" },
  { code: "5355", name: "ค่าธรรมเนียมอื่น ๆ", category: "ค่าใช้จ่าย" },
  { code: "5360", name: "ดอกเบี้ยจ่าย", category: "ค่าใช้จ่าย" },
  { code: "5365", name: "ค่าใช้จ่ายเบ็ดเตล็ด", category: "ค่าใช้จ่าย" },
  { code: "5366", name: "ค่าใช้จ่ายในการขาย", category: "ค่าใช้จ่าย" },
  { code: "5370", name: "ค่าเสื่อมราคา-อาคาร", category: "ค่าใช้จ่าย" },
  { code: "5375", name: "ค่าเสื่อมราคา-อุปกรณ์สำนักงาน", category: "ค่าใช้จ่าย" },
  { code: "5380", name: "ค่าเสื่อมราคา-รถยนต์", category: "ค่าใช้จ่าย" },
  { code: "5385", name: "ค่าเผื่อหนี้สูญ", category: "ค่าใช้จ่าย" },
  { code: "5910", name: "ภาษีเงินได้", category: "ค่าใช้จ่าย" },
  { code: "6000", name: "ค่าใช้จ่ายต้องห้าม", category: "อื่น ๆ" },
];

/** map รหัส → ชื่อมาตรฐาน (ใช้ตอนแสดง/ตรวจ) */
export const CHART_BY_CODE: Record<string, ChartAccount> = Object.fromEntries(
  CHART_OF_ACCOUNTS.map((a) => [a.code, a])
);

/** ค้นหาแบบ substring (รหัสหรือชื่อ) — ใช้ใน combobox */
export function searchChart(q: string): ChartAccount[] {
  const s = (q ?? '').trim().toLowerCase();
  if (!s) return CHART_OF_ACCOUNTS;
  return CHART_OF_ACCOUNTS.filter(
    (a) => a.code.toLowerCase().includes(s) || a.name.toLowerCase().includes(s)
  );
}

/**
 * รหัสบัญชี "เงินฝากธนาคาร" ทั้งหมดในผังกลาง (คำนวณจาก bank:true — ไม่ hardcode ซ้ำ)
 *   ใช้ validate ฝั่ง server (accountCode ที่ผูกกับ customer_bank_accounts ต้องเป็นรหัสเงินฝาก)
 *   ★ ปัจจุบัน = ["1020","1025","1030"] — เพิ่มรหัสเงินฝากในผังกลางแล้วชุดนี้ขยายเอง
 */
export const BANK_ACCOUNT_CODES: readonly string[] = CHART_OF_ACCOUNTS.filter(
  (a) => a.bank
).map((a) => a.code);

/** รหัสนี้เป็นบัญชีเงินฝากธนาคารไหม (ใช้ตรวจก่อนผูกบัญชีลูกค้า) */
export function isBankAccountCode(code: string): boolean {
  return BANK_ACCOUNT_CODES.includes(code);
}

/** ผังกลาง "ตัดหมวดเงินฝาก (bank:true) ออก" — ใช้ใน picker (แทนด้วยบัญชีของลูกค้าแทน) */
export function searchChartNonBank(q: string): ChartAccount[] {
  return searchChart(q).filter((a) => !a.bank);
}

/**
 * เซตรหัสบัญชี non-bank ที่มีอยู่จริงในผัง — ใช้ validate account_code ที่ AI แนะนำ
 *   (กันรหัสมั่ว/นอกผัง และกันหมวดเงินฝากธนาคารที่ AI ห้ามเลือก)
 */
export const NONBANK_ACCOUNT_CODES: ReadonlySet<string> = new Set(
  CHART_OF_ACCOUNTS.filter((a) => !a.bank).map((a) => a.code)
);

/** รหัสนี้เป็นบัญชี non-bank ที่มีในผังไหม (AI เลือกได้เฉพาะชุดนี้) */
export function isValidNonBankCode(code: string | null | undefined): boolean {
  return !!code && NONBANK_ACCOUNT_CODES.has(code.trim());
}

/** ชื่อหมวดตามเลขหลักแรกของรหัส (1..6) — ใช้เป็นหัวข้อคั่นใน dropdown */
export const CATEGORY_BY_DIGIT: Record<string, string> = {
  "1": "สินทรัพย์",
  "2": "หนี้สิน",
  "3": "ส่วนของผู้ถือหุ้น",
  "4": "รายได้",
  "5": "ค่าใช้จ่าย",
  "6": "อื่น ๆ",
};

/** หมวด (เลขหลักแรก 1..6) ของรหัสบัญชี — "6" (อื่น ๆ) ถ้าไม่ขึ้นต้นด้วย 1..6 */
export function categoryDigitOf(code: string): string {
  const c = (code ?? "").trim();
  return /^[1-6]/.test(c) ? c[0] : "6";
}

/** กลุ่มบัญชีตามหมวด (สำหรับ dropdown ที่มีหัวข้อคั่น) */
export type ChartGroup = { digit: string; category: string; accounts: ChartAccount[] };

/**
 * ค้นผังกลาง (non-bank) แบบ "จัดกลุ่มตามหมวด" สำหรับ dropdown เลือกบัญชี
 *   - q เป็นเลขหลักเดียว 1–6 → เด้งทั้งหมวดนั้น (code ขึ้นต้นด้วยเลขนั้น) ให้เลื่อนเลือกทั้งหมด
 *   - q อย่างอื่น (ชื่อ/รหัสหลายหลัก/ว่าง) → ค้น substring code/ชื่อ ตามเดิม
 *   คืนเฉพาะกลุ่มที่มีรายการ เรียงตามเลขหมวด 1→6
 */
export function searchChartNonBankGrouped(q: string): ChartGroup[] {
  const s = (q ?? "").trim();
  const singleDigit = /^[1-6]$/.test(s);
  const matched = singleDigit
    ? CHART_OF_ACCOUNTS.filter((a) => !a.bank && a.code.startsWith(s))
    : searchChartNonBank(s);

  // จัดกลุ่มตามหมวด (เลขหลักแรก) แล้วเรียง 1→6 (คงลำดับเดิมภายในหมวด)
  const byDigit = new Map<string, ChartAccount[]>();
  for (const a of matched) {
    const d = categoryDigitOf(a.code);
    const arr = byDigit.get(d) ?? [];
    arr.push(a);
    byDigit.set(d, arr);
  }
  const groups: ChartGroup[] = [];
  for (const d of ["1", "2", "3", "4", "5", "6"]) {
    const arr = byDigit.get(d);
    if (arr && arr.length > 0) groups.push({ digit: d, category: CATEGORY_BY_DIGIT[d], accounts: arr });
  }
  return groups;
}

/** เฉพาะบัญชีเงินฝาก generic (bank:true) — ใช้ fallback ตอนลูกค้ายังไม่มีบัญชีของตัวเอง */
export const BANK_ACCOUNTS: ChartAccount[] = CHART_OF_ACCOUNTS.filter((a) => a.bank);
