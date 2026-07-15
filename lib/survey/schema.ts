import { z } from "zod";
import type { NormalizedQuestion, QuestionType } from "./types";

/**
 * โครง schema_json ของ survey_versions เป็น JSON ที่มาจาก DB ของเราเอง (trusted)
 * แต่ยัง parse แบบ permissive + defensive เพื่อ:
 *   1) flatten คำถามให้เป็นรูปแบบเดียว (NormalizedQuestion) ใช้ validate/scoring
 *   2) ไม่ crash ถ้าโครงต่างชนิดกัน (A/C/D ใช้ sections, B ใช้ question_sets)
 */

const optionSchema = z.object({
  value: z.string(),
  label: z.string(),
  is_exclusive: z.boolean().optional(),
});

const questionSchema = z
  .object({
    code: z.string(),
    text: z.string().optional().default(""),
    type: z.enum(["rating", "single", "multi", "open", "nps"]),
    scale: z.number().optional(),
    options: z.array(optionSchema).optional(),
  })
  .passthrough();

const sectionSchema = z
  .object({
    code: z.string().optional(),
    title: z.string().optional(),
    questions: z.array(questionSchema).optional(),
  })
  .passthrough();

/** schema_json แบบหลวม — รองรับทั้ง sections และ question_sets (Form B) */
export const surveySchemaJsonSchema = z
  .object({
    type: z.string().optional(),
    title: z.string().optional(),
    estimated_minutes: z.number().optional(),
    intro: z.string().optional(),
    sections: z.array(sectionSchema).optional(),
    question_sets: z.record(z.array(questionSchema)).optional(),
    open_questions: z.array(questionSchema).optional(),
    exclusive_option: z.string().optional(),
    conditional_rules: z.array(z.record(z.unknown())).optional(),
    subject_selection: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type SurveySchemaJson = z.infer<typeof surveySchemaJsonSchema>;

type RawQuestion = z.infer<typeof questionSchema>;

function toNormalized(q: RawQuestion, group?: string): NormalizedQuestion {
  return {
    code: q.code,
    text: q.text ?? "",
    type: q.type as QuestionType,
    ...(typeof q.scale === "number" ? { scale: q.scale } : {}),
    ...(q.options ? { options: q.options } : {}),
    ...(group ? { group } : {}),
  };
}

/**
 * flatten คำถามทั้งหมดจาก schema_json → NormalizedQuestion[]
 * รวมทุกแหล่ง: sections[].questions, question_sets{group:[]}, open_questions
 * (เก็บซ้ำ code ไม่ได้ — ถ้าซ้ำจะยึดอันแรกที่เจอ)
 */
export function flattenQuestions(schema: unknown): NormalizedQuestion[] {
  const parsed = surveySchemaJsonSchema.safeParse(schema);
  const data: SurveySchemaJson = parsed.success
    ? parsed.data
    : (schema as SurveySchemaJson) ?? {};

  const out: NormalizedQuestion[] = [];
  const seen = new Set<string>();

  const push = (q: RawQuestion, group?: string) => {
    if (!q?.code || seen.has(q.code)) return;
    seen.add(q.code);
    out.push(toNormalized(q, group));
  };

  for (const section of data.sections ?? []) {
    for (const q of section.questions ?? []) push(q);
  }
  if (data.question_sets) {
    for (const [group, questions] of Object.entries(data.question_sets)) {
      for (const q of questions ?? []) push(q, group);
    }
  }
  for (const q of data.open_questions ?? []) push(q);

  return out;
}

/** สร้าง map code → NormalizedQuestion เพื่อ lookup เร็วตอน validate */
export function buildQuestionMap(
  questions: NormalizedQuestion[]
): Map<string, NormalizedQuestion> {
  return new Map(questions.map((q) => [q.code, q]));
}
