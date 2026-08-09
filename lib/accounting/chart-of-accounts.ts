/**
 * ผังบัญชี — type + ฟังก์ชัน pure ล้วน (ไม่มี module-level data อีกต่อไป)
 *
 * ★ เฟส 1 ส่วน A (docs/06-accounting-features-roadmap.md): ผังบัญชีย้ายจาก hardcode array
 *   (เดิมไฟล์นี้มี CHART_OF_ACCOUNTS 75 รายการ) → ตาราง `chart_of_accounts` (tenant-scoped ใน DB)
 *   ไฟล์นี้จึง "ไม่ fetch DB เอง" — ทุกฟังก์ชันรับ `chart: ChartAccount[]` (โหลดจาก DB โดย caller
 *   ผ่าน lib/accounting/chart-accounts-data.ts) เป็นพารามิเตอร์แทน module constant เดิมทั้งหมด
 *   ★ รหัสบัญชี (code) = ล็อกเมื่อเลือกแล้ว ห้ามแก้ · ชื่อบัญชี (name) = แก้ได้ต่อบรรทัด/ในผัง
 *   หมวดตามเลขหลักแรก: 1 สินทรัพย์ · 2 หนี้สิน · 3 ทุน · 4 รายได้ · 5 ค่าใช้จ่าย · 6 อื่น ๆ
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

/** map รหัส → ข้อมูลบัญชี (ใช้แสดง/ตรวจ) */
export type ChartByCode = Record<string, ChartAccount>;

/** สร้าง map รหัส→บัญชี จากผัง (คำนวณครั้งเดียวต่อรอบ ไม่ query/loop ซ้ำ) */
export function buildChartByCode(chart: ChartAccount[]): ChartByCode {
  return Object.fromEntries(chart.map((a) => [a.code, a]));
}

/** ค้นหาแบบ substring (รหัสหรือชื่อ) — ใช้ใน combobox */
export function searchChart(chart: ChartAccount[], q: string): ChartAccount[] {
  const s = (q ?? "").trim().toLowerCase();
  if (!s) return chart;
  return chart.filter(
    (a) => a.code.toLowerCase().includes(s) || a.name.toLowerCase().includes(s)
  );
}

/**
 * รหัสบัญชี "เงินฝากธนาคาร" ทั้งหมดในผัง (คำนวณจาก bank:true — ไม่ hardcode ซ้ำ)
 *   ใช้ validate ฝั่ง server (accountCode ที่ผูกกับ customer_bank_accounts ต้องเป็นรหัสเงินฝาก)
 */
export function bankAccountCodesOf(chart: ChartAccount[]): string[] {
  return chart.filter((a) => a.bank).map((a) => a.code);
}

/** รหัสนี้เป็นบัญชีเงินฝากธนาคารไหม (ใช้ตรวจก่อนผูกบัญชีลูกค้า) */
export function isBankAccountCode(chart: ChartAccount[], code: string): boolean {
  return bankAccountCodesOf(chart).includes(code);
}

/**
 * ผังสำหรับ picker — ★ รวมบัญชีเงินฝาก (bank:true) เข้าหมวด 1 ปกติ (เลิกตัดออก) เพื่อให้นักบัญชี
 *   เลือกเงินฝากธนาคารได้เหมือนบัญชีอื่น · ชื่อ generic แก้ต่อบรรทัดได้
 *   หมายเหตุ: ชื่อฟังก์ชันคง "NonBank" ไว้เพื่อความเข้ากันได้กับที่เรียกใช้เดิม
 */
export function searchChartNonBank(chart: ChartAccount[], q: string): ChartAccount[] {
  return searchChart(chart, q);
}

/**
 * เซตรหัสบัญชี non-bank ที่มีอยู่จริงในผัง — ใช้ validate account_code ที่ AI แนะนำ
 *   (กันรหัสมั่ว/นอกผัง และกันหมวดเงินฝากธนาคารที่ AI ห้ามเลือก)
 */
export function nonBankAccountCodesOf(chart: ChartAccount[]): ReadonlySet<string> {
  return new Set(chart.filter((a) => !a.bank).map((a) => a.code));
}

/** รหัสนี้เป็นบัญชี non-bank ที่มีในผังไหม (AI เลือกได้เฉพาะชุดนี้) */
export function isValidNonBankCode(chart: ChartAccount[], code: string | null | undefined): boolean {
  return !!code && nonBankAccountCodesOf(chart).has(code.trim());
}

/**
 * ชื่อหมวดตามเลขหลักแรกของรหัส (1..6) — ใช้เป็นหัวข้อคั่นใน dropdown
 *   ★ คงเป็น module constant (ไม่ย้ายเข้า DB) — เป็น convention ทางบัญชีตรึงตัว ไม่ใช่สิ่งที่ admin แก้ได้
 */
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
 * ค้นผัง (non-bank) แบบ "จัดกลุ่มตามหมวด" สำหรับ dropdown เลือกบัญชี
 *   - q เป็นเลขหลักเดียว 1–6 → เด้งทั้งหมวดนั้น (code ขึ้นต้นด้วยเลขนั้น) ให้เลื่อนเลือกทั้งหมด
 *   - q อย่างอื่น (ชื่อ/รหัสหลายหลัก/ว่าง) → ค้น substring code/ชื่อ ตามเดิม
 *   คืนเฉพาะกลุ่มที่มีรายการ เรียงตามเลขหมวด 1→6
 */
export function searchChartNonBankGrouped(chart: ChartAccount[], q: string): ChartGroup[] {
  const s = (q ?? "").trim();
  const singleDigit = /^[1-6]$/.test(s);
  // ★ รวมบัญชีเงินฝาก (bank:true) ด้วย — เงินฝากธนาคารเป็นตัวเลือกปกติในหมวด 1
  const matched = singleDigit
    ? chart.filter((a) => a.code.startsWith(s))
    : searchChartNonBank(chart, s);

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
export function bankAccountsOf(chart: ChartAccount[]): ChartAccount[] {
  return chart.filter((a) => a.bank);
}
