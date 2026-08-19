/**
 * แม็พชื่อคอลัมน์แบบยืดหยุ่นต่อแพลตฟอร์ม (Excel/CSV)
 * - แต่ละแพลตฟอร์มตั้งชื่อคอลัมน์ต่างกัน (ไทย/อังกฤษ) → เก็บ alias หลายชื่อต่อฟิลด์
 * - จับคู่แบบ normalize (ตัดช่องว่าง/ตัวพิมพ์เล็ก) แล้วเทียบ "มีคำสำคัญอยู่ในหัวคอลัมน์"
 *   เพื่อทนต่อหัวคอลัมน์ที่มีวงเล็บ/หน่วยเงินต่อท้าย เช่น "ยอดขายรวม (บาท)"
 */
import type { FigureField, Platform } from './types';
import { PLATFORM } from './types';

/** คำสำคัญ (lowercase) ที่บ่งบอกแต่ละฟิลด์ — เรียงจากเฉพาะเจาะจงไปกว้าง */
type FieldAliases = Record<FigureField, string[]>;

/** alias กลางที่ใช้ได้กับเกือบทุกแพลตฟอร์ม (ทั้งไทย/อังกฤษ) */
const COMMON_ALIASES: FieldAliases = {
  grossSales: [
    'ยอดขายรวม',
    'ยอดขาย',
    'ยอดคำสั่งซื้อ',
    'มูลค่าสินค้า',
    'gross sales',
    'gross',
    'total sales',
    'order amount',
    'sales amount',
    'subtotal',
    'amount',
    'total',
  ],
  platformFee: [
    'ค่าธรรมเนียม',
    'ค่าคอมมิชชั่น',
    'ค่าคอมมิชชัน',
    'ค่าคอม',
    'gp',
    'commission',
    'platform fee',
    'service fee',
    'transaction fee',
    'fee',
  ],
  shippingFee: [
    'ค่าขนส่ง',
    'ค่าจัดส่ง',
    'ค่าส่ง',
    'shipping fee',
    'shipping',
    'delivery fee',
    'delivery',
    'logistics',
  ],
  discount: [
    'ส่วนลด',
    'โปรโมชัน',
    'โปรโมชั่น',
    'discount',
    'promotion',
    'voucher',
    'coupon',
    'rebate',
  ],
};

/**
 * override เฉพาะแพลตฟอร์ม (ถ้าจำเป็น) — วางโครงไว้ให้เติมได้
 * ตอนนี้ทุกแพลตฟอร์มใช้ COMMON_ALIASES ก่อน; เพิ่ม key เฉพาะเมื่อเจอฟอร์แมตที่ชนกัน
 */
const PLATFORM_OVERRIDES: Partial<Record<Platform, Partial<FieldAliases>>> = {
  // ตัวอย่างการขยาย: TikTok ใช้คำว่า "settlement amount"
  [PLATFORM.TIKTOK]: {
    grossSales: ['settlement amount', 'total settlement', ...COMMON_ALIASES.grossSales],
  },
};

/** normalize หัวคอลัมน์เพื่อเทียบ: ตัดช่องว่างซ้ำ + เป็นตัวพิมพ์เล็ก */
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** คืน alias ที่ใช้กับแพลตฟอร์มนี้ (รวม override ถ้ามี) */
function aliasesFor(platform: Platform): FieldAliases {
  const override = PLATFORM_OVERRIDES[platform];
  if (!override) {
    return COMMON_ALIASES;
  }
  return {
    grossSales: override.grossSales ?? COMMON_ALIASES.grossSales,
    platformFee: override.platformFee ?? COMMON_ALIASES.platformFee,
    shippingFee: override.shippingFee ?? COMMON_ALIASES.shippingFee,
    discount: override.discount ?? COMMON_ALIASES.discount,
  };
}

/**
 * หา index ของคอลัมน์ที่ตรงกับฟิลด์ที่ต้องการจากรายการหัวคอลัมน์
 * - เทียบแบบ "หัวคอลัมน์ขึ้นต้น/มีคำสำคัญ" เพื่อทนต่อหน่วยต่อท้าย
 * - คืน -1 ถ้าไม่พบ
 */
export function findColumnIndex(headers: string[], aliases: string[]): number {
  const normalizedHeaders = headers.map(normalizeHeader);

  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const idx = normalizedHeaders.findIndex(
      (h) => h === normalizedAlias || h.includes(normalizedAlias),
    );
    if (idx !== -1) {
      return idx;
    }
  }
  return -1;
}

/** map ฟิลด์ทั้ง 4 -> index คอลัมน์ (หรือ -1 ถ้าไม่พบ) สำหรับแพลตฟอร์มหนึ่ง */
export function mapColumns(headers: string[], platform: Platform): Record<FigureField, number> {
  const aliases = aliasesFor(platform);
  return {
    grossSales: findColumnIndex(headers, aliases.grossSales),
    platformFee: findColumnIndex(headers, aliases.platformFee),
    shippingFee: findColumnIndex(headers, aliases.shippingFee),
    discount: findColumnIndex(headers, aliases.discount),
  };
}

/**
 * นิยาม mapping แบบ "หลายคอลัมน์ → 1 ฟิลด์" (สำหรับฟอร์แมตที่แยกค่าเป็นหลายคอลัมน์ เช่น Shopee)
 * - matchers: หัวคอลัมน์ที่ต้องตรง "ทั้งชื่อ" (exact ตาม normalize) — ป้องกันจับผิดคอลัมน์คล้ายกัน
 * - เก็บทุก index ที่ match เพื่อนำไป "รวมผลรวม" (sum) ที่ชั้น parse-file
 */
export interface FieldColumnSpec {
  /** index คอลัมน์ทั้งหมดที่รวมเข้าฟิลด์นี้ */
  indices: number[];
}

export type MultiColumnMapping = Record<FigureField, FieldColumnSpec>;

/**
 * ชื่อหัวคอลัมน์จริงของรายงาน Shopee (ชีต Income) → ฟิลด์กลาง
 * อ้างอิงไฟล์ export จริง (header แถวที่ 6). Shopee เก็บ "ค่าใช้จ่าย/ส่วนลด" เป็นค่าติดลบ
 * แต่ parse-file จะทำเป็นค่าบวก (จำนวนที่หัก) ให้ตรง convention ของ settlement เอง
 */
const SHOPEE_COLUMN_GROUPS: Record<FigureField, string[]> = {
  // ยอดขายก่อนหักส่วนลด/คืนเงิน (Shopee เรียก "สินค้าราคาปกติ")
  grossSales: ['สินค้าราคาปกติ'],
  // GP = ค่าคอมมิชชั่น + ค่าบริการ + ค่าคอมมิชชั่น AMS + ค่าธุรกรรมการชำระเงิน
  platformFee: [
    'ค่าคอมมิชชั่น',
    'ค่าคอมมิชชัน',
    'ค่าคอมมิชชั่น ams',
    'ค่าคอมมิชชัน ams',
    'ค่าบริการ',
    'ค่าธุรกรรมการชำระเงิน',
  ],
  // ค่าจัดส่งสุทธิที่กระทบผู้ขาย (จ่ายเข้า − ที่ Shopee หักคืน)
  shippingFee: [
    'ค่าจัดส่งที่ชำระโดยผู้ซื้อ',
    'ค่าจัดส่งสินค้าที่ออกโดย shopee',
    'ค่าจัดส่งที่ shopee ชำระโดยชื่อของคุณ',
    'ค่าจัดส่งสินค้าคืน',
    'ค่าจัดส่งสินค้าคืนผู้ขาย',
    'โปรแกรมประหยัดค่าจัดส่งคืนสินค้า',
  ],
  // ส่วนลดฝั่งผู้ขาย + เงินคืนผู้ซื้อ + โค้ดส่วนลดของผู้ขาย
  discount: [
    'ส่วนลดสินค้าจากผู้ขาย',
    'จำนวนเงินที่ทำการคืนให้ผู้ซื้อ',
    'โค้ดส่วนลดที่ออกโดยผู้ขาย',
    'โค้ดส่วนลดร่วมที่ออกโดยผู้ขาย',
  ],
};

/**
 * หา index "ทุกคอลัมน์" ที่ชื่อหัวตรงกับรายการที่ให้ (เทียบแบบ exact หลัง normalize)
 * ใช้ exact match เพื่อไม่ให้ "ค่าคอมมิชชั่น" ไปจับ "ค่าคอมมิชชั่น AMS" ซ้ำ (คุมผลรวมให้ถูก)
 */
function findAllExactColumns(headers: string[], names: string[]): number[] {
  const normalizedHeaders = headers.map(normalizeHeader);
  const normalizedNames = names.map(normalizeHeader);
  const indices: number[] = [];
  normalizedHeaders.forEach((header, idx) => {
    if (normalizedNames.includes(header)) {
      indices.push(idx);
    }
  });
  return indices;
}

/** true ถ้า header ชุดนี้ "หน้าตาเป็นรายงาน Shopee แบบละเอียด" (มีคอลัมน์เฉพาะของ Shopee) */
export function isShopeeDetailedReport(headers: string[]): boolean {
  const gross = findAllExactColumns(headers, SHOPEE_COLUMN_GROUPS.grossSales);
  const fee = findAllExactColumns(headers, SHOPEE_COLUMN_GROUPS.platformFee);
  // ต้องเจอทั้งคอลัมน์ยอดขายเฉพาะ + คอลัมน์ค่าธรรมเนียมเฉพาะ จึงถือว่าใช่
  return gross.length > 0 && fee.length > 0;
}

/**
 * map แบบหลายคอลัมน์สำหรับรายงาน Shopee ละเอียด (ชีต Income)
 * คืน index ทุกคอลัมน์ต่อฟิลด์ เพื่อให้ parse-file รวมผลรวมเอง
 */
export function mapShopeeColumns(headers: string[]): MultiColumnMapping {
  return {
    grossSales: { indices: findAllExactColumns(headers, SHOPEE_COLUMN_GROUPS.grossSales) },
    platformFee: { indices: findAllExactColumns(headers, SHOPEE_COLUMN_GROUPS.platformFee) },
    shippingFee: { indices: findAllExactColumns(headers, SHOPEE_COLUMN_GROUPS.shippingFee) },
    discount: { indices: findAllExactColumns(headers, SHOPEE_COLUMN_GROUPS.discount) },
  };
}

/**
 * ชื่อหัวคอลัมน์จริงของรายงาน TikTok Shop (ชีต "รายละเอียดคำสั่งซื้อ", header แถว 1) → ฟิลด์กลาง
 * อ้างอิงไฟล์ export จริง (income_2025-03.xlsx). TikTok เก็บ "ค่าธรรมเนียม/ค่าจัดส่งที่หัก"
 * เป็นค่าติดลบ แต่ parse-file จะทำเป็นค่าบวก (จำนวนที่หัก) ให้ตรง convention ของ settlement
 *
 * เลือก exact match (ไม่ใช่ substring) เพื่อกันจับผิดคอลัมน์ที่ชื่อคล้ายกันมาก เช่น
 * "ค่าธรรมเนียมทั้งหมด" (ยอดรวม GP) ต้องไม่ไปโดน "ค่าธรรมเนียมคำสั่งซื้อ" ที่เป็นส่วนย่อย
 * และ shippingFee ใช้ "ยอดรวมค่าจัดส่งที่ร้านค้าจ่ายจริง" (ยอด net) ไม่ใช่คอลัมน์ย่อยหลายตัว
 */
const TIKTOK_COLUMN_GROUPS: Record<FigureField, string[]> = {
  // ยอดขายก่อนหักส่วนลด (ค่าบวกอยู่แล้ว)
  grossSales: ['ยอดรวมค่าสินค้าก่อนหักส่วนลด'],
  // GP = "ค่าธรรมเนียมทั้งหมด" — TikTok รวมค่าธรรมเนียมทุกชนิดมาให้แล้วในคอลัมน์เดียว (ติดลบ)
  platformFee: ['ค่าธรรมเนียมทั้งหมด'],
  // ค่าจัดส่งสุทธิที่ร้านจ่ายจริง (TikTok รวม net ของค่าจัดส่งย่อยมาให้แล้ว, ติดลบ/0)
  shippingFee: ['ยอดรวมค่าจัดส่งที่ร้านค้าจ่ายจริง'],
  // ส่วนลดฝั่งร้านค้า + เงินคืนจากส่วนลดร้าน (ติดลบ/0)
  discount: ['ส่วนลดจากร้านค้า', 'เงินคืนจากส่วนลดร้านค้า'],
};

/** true ถ้า header ชุดนี้ "หน้าตาเป็นรายงาน TikTok Shop" (มีคอลัมน์เฉพาะของ TikTok) */
export function isTikTokReport(headers: string[]): boolean {
  const gross = findAllExactColumns(headers, TIKTOK_COLUMN_GROUPS.grossSales);
  const fee = findAllExactColumns(headers, TIKTOK_COLUMN_GROUPS.platformFee);
  // ต้องเจอทั้งคอลัมน์ยอดขายเฉพาะ + คอลัมน์ค่าธรรมเนียมรวมเฉพาะ จึงถือว่าใช่
  return gross.length > 0 && fee.length > 0;
}

/**
 * map แบบหลายคอลัมน์สำหรับรายงาน TikTok Shop (ชีต "รายละเอียดคำสั่งซื้อ")
 * คืน index ทุกคอลัมน์ต่อฟิลด์ เพื่อให้ parse-file รวมผลรวมเอง (ส่วนใหญ่ฟิลด์ละ 1 คอลัมน์)
 */
export function mapTikTokColumns(headers: string[]): MultiColumnMapping {
  return {
    grossSales: { indices: findAllExactColumns(headers, TIKTOK_COLUMN_GROUPS.grossSales) },
    platformFee: { indices: findAllExactColumns(headers, TIKTOK_COLUMN_GROUPS.platformFee) },
    shippingFee: { indices: findAllExactColumns(headers, TIKTOK_COLUMN_GROUPS.shippingFee) },
    discount: { indices: findAllExactColumns(headers, TIKTOK_COLUMN_GROUPS.discount) },
  };
}

/**
 * keyword ที่ใช้สแกนหา "ชีต/แถวหัวตาราง" ของรายงานยอดขาย (ครอบทั้งฟอร์แมตทั่วไป + Shopee/TikTok ละเอียด)
 * ส่งให้ selectDataTable เพื่อเลือกชีตที่ตรงคอลัมน์ที่จะอ่านมากสุด
 */
export function salesHeaderKeywords(platform: Platform): string[] {
  const aliases = aliasesFor(platform);
  const common = [
    ...aliases.grossSales,
    ...aliases.platformFee,
    ...aliases.shippingFee,
    ...aliases.discount,
  ];
  const shopeeSpecific = [
    ...SHOPEE_COLUMN_GROUPS.grossSales,
    ...SHOPEE_COLUMN_GROUPS.platformFee,
    ...SHOPEE_COLUMN_GROUPS.shippingFee,
    ...SHOPEE_COLUMN_GROUPS.discount,
    ...SHOPEE_DATE_COLUMNS.paid,
    ...SHOPEE_DATE_COLUMNS.ordered,
    'หมายเลขคำสั่งซื้อ',
    'จำนวนเงินทั้งหมดที่โอนแล้ว',
  ];
  const tiktokSpecific = [
    ...TIKTOK_COLUMN_GROUPS.grossSales,
    ...TIKTOK_COLUMN_GROUPS.platformFee,
    ...TIKTOK_COLUMN_GROUPS.shippingFee,
    ...TIKTOK_COLUMN_GROUPS.discount,
    ...TIKTOK_DATE_COLUMNS.paid,
    ...TIKTOK_DATE_COLUMNS.ordered,
    'ประเภทธุรกรรม',
    'หมายเลขคำสั่งซื้อ/การปรับ',
  ];
  return [
    ...new Set([...common, ...shopeeSpecific, ...tiktokSpecific].map((k) => k.toLowerCase())),
  ];
}

/** ชื่อชีตที่ควรได้ priority เมื่อเลือกชีตข้อมูลยอดขาย (tie-break) */
export const SALES_SHEET_PRIORITY_NAMES = ['income', 'order', 'orders', 'รายรับ', 'รายการ'];

// ------------------------------------------------------------------
// คอลัมน์วันที่ (ใช้จัดกลุ่มยอดรายเดือน)
// ------------------------------------------------------------------

/**
 * ชื่อหัวคอลัมน์ "วันที่" ที่ใช้จัดกลุ่มเดือนของแต่ละแพลตฟอร์ม (อ้างไฟล์ export จริง)
 * - primary = วันที่โอน/ชำระเงินสำเร็จ (ตามมติผู้ใช้: จัดกลุ่มตามวันที่ชำระ)
 * - fallback = วันที่สั่งซื้อ (ใช้เมื่อวันที่ชำระของแถวนั้นว่าง)
 * เทียบแบบ exact หลัง normalize (กันจับคอลัมน์ชื่อคล้ายกันผิด)
 */
export interface DateColumnSpec {
  /** index คอลัมน์วันที่ชำระ (primary) หรือ -1 ถ้าไม่พบ */
  paidIndex: number;
  /** index คอลัมน์วันที่สั่งซื้อ (fallback) หรือ -1 ถ้าไม่พบ */
  orderedIndex: number;
}

const SHOPEE_DATE_COLUMNS = {
  paid: ['วันที่โอนชำระเงินสำเร็จ'],
  ordered: ['วันที่ทำการสั่งซื้อ'],
} as const;

const TIKTOK_DATE_COLUMNS = {
  paid: ['เวลาที่ชำระคำสั่งซื้อ'],
  ordered: ['เวลาที่สร้างคำสั่งซื้อ'],
} as const;

/** หา index คอลัมน์แรกที่ชื่อหัวตรง (exact หลัง normalize) — คืน -1 ถ้าไม่พบ */
function findFirstExactColumn(headers: string[], names: readonly string[]): number {
  const normalizedHeaders = headers.map(normalizeHeader);
  const normalizedNames = names.map(normalizeHeader);
  return normalizedHeaders.findIndex((header) => normalizedNames.includes(header));
}

/** map คอลัมน์วันที่ (ชำระ + สั่งซื้อ) ของ Shopee ละเอียด */
export function mapShopeeDateColumns(headers: string[]): DateColumnSpec {
  return {
    paidIndex: findFirstExactColumn(headers, SHOPEE_DATE_COLUMNS.paid),
    orderedIndex: findFirstExactColumn(headers, SHOPEE_DATE_COLUMNS.ordered),
  };
}

/** map คอลัมน์วันที่ (ชำระ + สั่งซื้อ) ของ TikTok Shop */
export function mapTikTokDateColumns(headers: string[]): DateColumnSpec {
  return {
    paidIndex: findFirstExactColumn(headers, TIKTOK_DATE_COLUMNS.paid),
    orderedIndex: findFirstExactColumn(headers, TIKTOK_DATE_COLUMNS.ordered),
  };
}

/**
 * แปลงค่าดิบในเซลล์วันที่ → คีย์เดือน 'YYYY-MM' (ค.ศ.) — คืน null ถ้าอ่านไม่ได้/ว่าง
 *
 * รองรับหลายรูปแบบที่พบในไฟล์จริง:
 *   - Shopee: '2025-01-31' (ISO)  · TikTok: '2025/03/31' (slash)
 *   - มี/ไม่มีเวลาต่อท้าย เช่น '2025/03/31 12:00:00', '2025-01-31 23:59'
 *   - เซลล์เป็น Date object (exceljs อาจคืน Date จาก cell ที่ฟอร์แมตเป็นวันที่)
 * รับเฉพาะปี 4 หลัก + เดือน 1–12 ที่สมเหตุสมผล เพื่อกันจับตัวเลขอื่นเป็นเดือน
 */
export function parseMonthKey(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  // เซลล์ที่ exceljs คืนเป็น Date — ใช้ UTC เพื่อไม่ให้ timezone เลื่อนวัน/เดือน
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      return null;
    }
    const year = raw.getUTCFullYear();
    const month = raw.getUTCMonth() + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  const text = String(raw).trim();
  if (text === '') {
    return null;
  }

  // ดึง YYYY-MM หรือ YYYY/MM จากต้นสตริง (ตัวคั่นเป็น - หรือ /)
  const match = text.match(/^(\d{4})[-/](\d{1,2})/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}
