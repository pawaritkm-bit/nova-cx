/**
 * ชนิดแบบประเมิน 4 ประเภท (A/B/C/D) + mapping slug ที่อ่านง่ายสำหรับ API/URL
 *   A = office        แบบประเมินสำนักงาน (ราย 3 เดือน)
 *   B = accountant    แบบประเมินนักบัญชี (รายเดือน, Form B ผูกผู้ดูแลอัตโนมัติ)
 *   C = sales-won     แบบประเมินเซล (ปิดการขายได้)
 *   D = sales-lost    แบบประเมินเซล (ปิดการขายไม่ได้)
 */
export const SURVEY_TYPES = ["A", "B", "C", "D"] as const;
export type SurveyType = (typeof SURVEY_TYPES)[number];

export const SURVEY_TYPE_BY_SLUG: Record<string, SurveyType> = {
  office: "A",
  accountant: "B",
  "sales-won": "C",
  "sales-lost": "D",
};

export const SURVEY_SLUG_BY_TYPE: Record<SurveyType, string> = {
  A: "office",
  B: "accountant",
  C: "sales-won",
  D: "sales-lost",
};

/** true เมื่อค่าที่รับเข้ามาเป็น SurveyType ที่ถูกต้อง */
export function isSurveyType(value: string): value is SurveyType {
  return (SURVEY_TYPES as readonly string[]).includes(value);
}

/** แปลง slug → SurveyType (คืน null ถ้าไม่รู้จัก) */
export function surveyTypeFromSlug(slug: string): SurveyType | null {
  return SURVEY_TYPE_BY_SLUG[slug] ?? null;
}

export type QuestionType = "rating" | "single" | "multi" | "open" | "nps";

/** คำถามที่ถูก flatten จาก schema_json (versioned JSON) ให้เป็นรูปแบบเดียวใช้ง่าย */
export type NormalizedQuestion = {
  code: string;
  text: string;
  type: QuestionType;
  scale?: number;
  options?: { value: string; label: string; is_exclusive?: boolean }[];
  /** สำหรับ Form B: กลุ่มคำถามตามบทบาทผู้ถูกประเมิน (lead/member) */
  group?: string;
  /** สำหรับ Form B: id ผู้ถูกประเมินที่คำถามนี้ผูกอยู่ (per-subject) */
  subject_id?: string;
};
