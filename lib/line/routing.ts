import type { LineOa } from "@/lib/env";

/**
 * OA routing ตามชนิดแบบประเมิน (FR-LN-00, FR-SC)
 *
 *   ชนิด A (สำนักงาน)  → OA "Care"  → ส่งเข้า "กลุ่ม LINE" (group)
 *   ชนิด B (นักบัญชี)   → OA "Care"  → ส่งเข้า "แชตส่วนตัว" (user, 1:1)
 *   ชนิด C (ขายได้)     → OA "Sale"  → ส่งเข้า "แชตส่วนตัว" (user, 1:1)
 *   ชนิด D (ขายไม่ได้)  → OA "Sale"  → ส่งเข้า "แชตส่วนตัว" (user, 1:1)
 *
 * pure function → unit test ได้ทันที
 */

export type SurveyType = "A" | "B" | "C" | "D";
export type LineChannelTarget = "group" | "user";

/** ชนิดแบบประเมิน → OA (Care/Sale) */
export function oaForSurveyType(surveyType: string): LineOa {
  // A/B = ทีมบัญชี (Care) ; C/D = ทีมขาย (Sale)
  return surveyType === "C" || surveyType === "D" ? "sale" : "care";
}

/** ชนิดแบบประเมิน → ช่องทางส่ง (กลุ่ม/ส่วนตัว) */
export function channelForSurveyType(surveyType: string): LineChannelTarget {
  // เฉพาะสำนักงาน (A) ส่งเข้ากลุ่ม; ที่เหลือส่งแชตส่วนตัว
  return surveyType === "A" ? "group" : "user";
}
