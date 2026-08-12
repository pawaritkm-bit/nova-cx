/**
 * วิเคราะห์รายงานสรุปยอดขาย/settlement report จากแพลตฟอร์มขายของ (Shopee/Lazada/TikTok Shop/
 * เดลิเวอรี่ ฯลฯ) — pure helpers (ทดสอบได้ ไม่แตะ DB/network)
 *
 * ★ 2026-08-12 (ข้อ C) — โจทย์: "แยกค่าใช้จ่ายต่างๆของแพลตฟอร์ม และยอดขายออกจากกัน ให้เหลือกำไรจริง"
 *   รับลิสต์รายการที่ AI สกัดมาแล้ว (ยอดขาย/ค่าธรรมเนียมแต่ละประเภท/เงินคืน ฯลฯ) แล้วสรุป:
 *   1) รวมยอดขาย (credit) vs รวมรายการที่ถูกหัก (deduct) แยกตามประเภท → เหลือ "กำไร/เงินที่ได้รับจริงสุทธิ"
 *   2) สรุปรายเดือน (ตัดเดือนตามเวลาไทยเหมือนสเตทเมนต์ธนาคาร — ใช้ bkkMonthKey เดียวกัน)
 *
 * ★ PDPA: ที่นี่ไม่ log อะไรเลย (รับ/คืน plain value) — caller เป็นคน gate สิทธิ์
 */
import { bkkMonthKey } from "@/lib/accounting/statement-analyze";

/** ประเภทรายการในรายงานแพลตฟอร์ม */
export type PlatformCategory =
  | "sales"
  | "commission_fee"
  | "payment_fee"
  | "shipping_fee"
  | "ads_fee"
  | "penalty"
  | "refund"
  | "other";

/** ป้ายภาษาไทยของแต่ละประเภท (ใช้แสดงผล) */
export const PLATFORM_CATEGORY_LABEL: Record<PlatformCategory, string> = {
  sales: "ยอดขาย",
  commission_fee: "ค่าคอมมิชชั่นแพลตฟอร์ม",
  payment_fee: "ค่าธรรมเนียมการรับเงิน",
  shipping_fee: "ค่าส่ง/ค่าขนส่ง",
  ads_fee: "ค่าโฆษณา/โปรโมท",
  penalty: "ค่าปรับ",
  refund: "เงินคืน/ยกเลิกออเดอร์",
  other: "อื่นๆ",
};

/** ลำดับประเภทที่ต้องการแสดง (ยอดขายก่อน แล้วตามด้วยรายการหักต่างๆ) */
export const PLATFORM_CATEGORY_ORDER: PlatformCategory[] = [
  "sales",
  "commission_fee",
  "payment_fee",
  "shipping_fee",
  "ads_fee",
  "penalty",
  "refund",
  "other",
];

/** ทิศทางผลต่อยอดที่ผู้ขายจะได้รับ: credit=เพิ่มยอด(ยอดขาย/ปรับปรุงเพิ่ม) · deduct=ถูกหักออก(ค่าธรรมเนียมทุกชนิด/เงินคืน/ค่าปรับ) */
export type PlatformLineDirection = "credit" | "deduct";

/** 1 รายการในรายงานแพลตฟอร์ม (ช่องที่ AI ไม่มั่นใจ = null) */
export type PlatformReportLine = {
  /** วันที่ 'YYYY-MM-DD' (ค.ศ.) หรือ timestamp ISO · null = อ่านไม่ได้ */
  date: string | null;
  /** เลขที่คำสั่งซื้อ/เลขอ้างอิงรายการ · null = ไม่มี/อ่านไม่ได้ */
  order_no: string | null;
  description: string | null;
  category: PlatformCategory | null;
  direction: PlatformLineDirection | null;
  /** ยอดเงิน (บวกเสมอ) · null = อ่านตัวเลขไม่ได้ */
  amount: number | null;
};

/** ยอดรวมแยกตามประเภท */
export type PlatformCategoryTotal = {
  category: PlatformCategory;
  count: number;
  total: number;
};

/** สรุปรวมทั้งหมด (ทุกไฟล์/ทุกเดือน) */
export type PlatformReportSummary = {
  /** รวมยอดขาย (category='sales' && direction='credit') */
  grossSales: number;
  /** รวมรายการ credit อื่น ๆ ที่ไม่ใช่ยอดขาย (เช่นเงินปรับปรุงเพิ่ม) */
  otherCredit: number;
  /** รวมทุกรายการที่ถูกหัก แยกตามประเภท เรียงตาม PLATFORM_CATEGORY_ORDER */
  deductions: PlatformCategoryTotal[];
  /** รวมยอดที่ถูกหักทั้งหมด (ผลรวมของ deductions[].total) */
  totalDeductions: number;
  /** กำไร/เงินที่ได้รับจริงสุทธิ = grossSales + otherCredit − totalDeductions */
  netAmount: number;
  count: number;
};

/** สรุปรายเดือน */
export type PlatformMonthlySummary = {
  /** 'YYYY-MM' (เวลาไทย) · '' = ไม่ระบุเดือน */
  month: string;
  grossSales: number;
  totalDeductions: number;
  netAmount: number;
  count: number;
};

/** ยอดเงินที่ใช้ได้ (บวก) — null/ผิดปกติ = 0 */
function safeAmount(v: number | null): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** สรุปยอดขาย/ค่าธรรมเนียม/กำไรสุทธิ รวมทุกรายการ (ไม่แยกเดือน) */
export function summarizePlatformReport(lines: PlatformReportLine[]): PlatformReportSummary {
  let grossSales = 0;
  let otherCredit = 0;
  const byCategory = new Map<PlatformCategory, { count: number; total: number }>();

  for (const l of lines) {
    const amt = safeAmount(l.amount);
    if (l.direction === "credit") {
      if (l.category === "sales") grossSales += amt;
      else otherCredit += amt;
    } else if (l.direction === "deduct") {
      // ★ ป้องกันบั๊ก: ถ้า category='sales' แต่ direction='deduct' (เช่นผู้ใช้แก้ตารางเองแล้วติดคอมโบนี้มา —
      //   รายการยอดขายที่ถูกยกเลิก/หักคืน) ต้องยังถูกนับใน totalDeductions เสมอ ไม่งั้นกำไรสุทธิจะสูงเกินจริง
      //   แบบเงียบ ๆ (พบจาก independent review) — bucket เป็น 'other' แทนที่จะทิ้ง (การ์ด "ยอดขาย" ไม่ควร
      //   ปรากฏใต้หมวดรายการที่ถูกหัก เพราะอ่านสับสน)
      const cat = l.category === "sales" || !l.category ? "other" : l.category;
      const agg = byCategory.get(cat) ?? { count: 0, total: 0 };
      agg.count += 1;
      agg.total += amt;
      byCategory.set(cat, agg);
    }
  }

  const deductions: PlatformCategoryTotal[] = PLATFORM_CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((c) => ({
    category: c,
    count: byCategory.get(c)!.count,
    total: byCategory.get(c)!.total,
  }));
  const totalDeductions = deductions.reduce((s, d) => s + d.total, 0);

  return {
    grossSales,
    otherCredit,
    deductions,
    totalDeductions,
    netAmount: grossSales + otherCredit - totalDeductions,
    count: lines.length,
  };
}

/** สรุปรายเดือน (เวลาไทย) — เรียงเดือนล่าสุดก่อน */
export function summarizePlatformReportByMonth(lines: PlatformReportLine[]): PlatformMonthlySummary[] {
  const map = new Map<string, PlatformMonthlySummary>();
  for (const l of lines) {
    const key = bkkMonthKey(l.date) ?? "";
    let row = map.get(key);
    if (!row) {
      row = { month: key, grossSales: 0, totalDeductions: 0, netAmount: 0, count: 0 };
      map.set(key, row);
    }
    row.count += 1;
    const amt = safeAmount(l.amount);
    if (l.direction === "credit") {
      row.grossSales += amt; // รวม otherCredit เข้ายอดเดียวกันในมุมมองรายเดือน (เพื่อความเรียบง่ายของการ์ดสรุป)
    } else if (l.direction === "deduct") {
      row.totalDeductions += amt;
    }
  }
  for (const row of map.values()) {
    row.netAmount = row.grossSales - row.totalDeductions;
  }
  return [...map.values()].sort((a, b) => {
    if (a.month === b.month) return 0;
    if (!a.month) return 1;
    if (!b.month) return -1;
    return a.month < b.month ? 1 : -1;
  });
}
