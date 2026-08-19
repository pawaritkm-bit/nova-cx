/**
 * types.ts — ชนิดข้อมูลของ "ตัวอ่านรายงานแพลตฟอร์มด้วยโค้ด" (port จาก NOVA Sales)
 *   อ่าน Shopee/TikTok/Lazada ฯลฯ → 4 ตัวเลข: ยอดขายรวม/ค่าธรรมเนียม-GP/ค่าขนส่ง/ส่วนลด + รายเดือน
 */

export const PLATFORM = {
  SHOPEE: "shopee",
  LAZADA: "lazada",
  TIKTOK: "tiktok",
  GRAB: "grab",
  LINE_MAN: "lineman",
  FOOD_STORY: "foodstory",
  STATEMENT: "statement",
} as const;
export type Platform = (typeof PLATFORM)[keyof typeof PLATFORM];

export const PLATFORM_LABELS: Record<Platform, string> = {
  shopee: "Shopee",
  lazada: "Lazada",
  tiktok: "TikTok Shop",
  grab: "Grab",
  lineman: "LINE MAN",
  foodstory: "FoodStory",
  statement: "Bank Statement",
};

export type FigureField = "grossSales" | "platformFee" | "shippingFee" | "discount";

export const UNKNOWN_MONTH_KEY = "unknown";

export interface MonthlyPlatformFigures {
  month: string;
  grossSales: number;
  platformFee: number;
  shippingFee: number;
  discount: number;
}

export interface ExtractedFigures {
  grossSales: number;
  platformFee: number;
  shippingFee: number;
  discount: number;
  monthly?: MonthlyPlatformFigures[];
}

export const EXTRACTED_FIELDS: { key: FigureField; label: string }[] = [
  { key: "grossSales", label: "ยอดขายรวม" },
  { key: "platformFee", label: "ค่าธรรมเนียม/GP" },
  { key: "shippingFee", label: "ค่าขนส่ง" },
  { key: "discount", label: "ส่วนลด" },
];

export const FIGURE_SOURCE = {
  CODE_PARSE: "code_parse",
  AI_MOCK: "ai_mock",
  AI_REAL: "ai_real",
} as const;
export type FigureSource = (typeof FIGURE_SOURCE)[keyof typeof FIGURE_SOURCE];

export interface FileExtraction {
  fileName: string;
  platform: Platform;
  source: FigureSource;
  figures: ExtractedFigures;
  missingFields: FigureField[];
  note?: string;
}
