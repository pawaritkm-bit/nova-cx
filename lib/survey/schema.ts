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

function toNormalized(
  q: RawQuestion,
  extra?: { group?: string; code?: string; subjectId?: string }
): NormalizedQuestion {
  return {
    code: extra?.code ?? q.code,
    text: q.text ?? "",
    type: q.type as QuestionType,
    ...(typeof q.scale === "number" ? { scale: q.scale } : {}),
    ...(q.options ? { options: q.options } : {}),
    ...(extra?.group ? { group: extra.group } : {}),
    ...(extra?.subjectId ? { subject_id: extra.subjectId } : {}),
  };
}

/** ผู้ถูกประเมิน (Form B) เท่าที่ flatten ต้องใช้ผูก per-subject */
export type FlattenSubject = { employee_id?: string; subject_role?: string };

/** ตัวเลือกเสริมของ flattenQuestions — ส่ง subjects เข้ามาเพื่อ expand คำถาม Form B ต่อคน */
export type FlattenOptions = { subjects?: FlattenSubject[] };

/**
 * สร้าง answer key แบบ per-subject ของ Form B: `<employee_id>__<question_code>`
 * ต้องใช้สูตรเดียวกันทั้งฝั่ง client (SurveyClient) และ server (validate/scoring)
 * (employee_id เป็น UUID ไม่มี "__" จึง parse กลับได้ตรง)
 */
export function subjectQuestionCode(subjectId: string, code: string): string {
  return `${subjectId}__${code}`;
}

/**
 * เลือกชุดคำถามที่ใช้กับผู้ถูกประเมินตามบทบาท (subject_role)
 *   - มีชุดตรงบทบาท → ใช้ชุดนั้น
 *   - ไม่มี → fallback เป็นชุด "member" (บทบาทที่พบบ่อยสุด) แล้วค่อยชุดแรกที่มี
 * generic เพื่อใช้ได้ทั้งฝั่ง server (RawQuestion) และ client (Question)
 */
export function resolveSubjectSet<T>(
  sets: Record<string, T[]> | undefined,
  role?: string
): T[] {
  if (!sets) return [];
  if (role && Array.isArray(sets[role])) return sets[role];
  if (Array.isArray(sets.member)) return sets.member;
  const firstKey = Object.keys(sets)[0];
  return firstKey ? (sets[firstKey] ?? []) : [];
}

/**
 * flatten คำถามทั้งหมดจาก schema_json → NormalizedQuestion[]
 * รวมทุกแหล่ง: sections[].questions, question_sets{group:[]}, open_questions
 * (เก็บซ้ำ code ไม่ได้ — ถ้าซ้ำจะยึดอันแรกที่เจอ)
 */
export function flattenQuestions(
  schema: unknown,
  opts?: FlattenOptions
): NormalizedQuestion[] {
  const parsed = surveySchemaJsonSchema.safeParse(schema);
  const data: SurveySchemaJson = parsed.success
    ? parsed.data
    : (schema as SurveySchemaJson) ?? {};

  const out: NormalizedQuestion[] = [];
  const seen = new Set<string>();

  const push = (
    q: RawQuestion,
    extra?: { group?: string; code?: string; subjectId?: string }
  ) => {
    const code = extra?.code ?? q?.code;
    if (!q?.code || !code || seen.has(code)) return;
    seen.add(code);
    out.push(toNormalized(q, { ...extra, code }));
  };

  for (const section of data.sections ?? []) {
    for (const q of section.questions ?? []) push(q);
  }

  if (data.question_sets) {
    // ผู้ถูกประเมิน (Form B) เท่าที่มี snapshot ผูกไว้กับ invitation นี้
    const subjects = (opts?.subjects ?? []).filter((s) => s?.employee_id);
    if (subjects.length > 0) {
      // per-subject: ประเมินหลายคน → คำถามชุดตามบทบาทของแต่ละคน + code เฉพาะคน
      for (const subject of subjects) {
        const set = resolveSubjectSet(data.question_sets, subject.subject_role);
        for (const q of set ?? []) {
          if (!q?.code) continue;
          push(q, {
            code: subjectQuestionCode(subject.employee_id!, q.code),
            group: subject.subject_role,
            subjectId: subject.employee_id,
          });
        }
      }
    } else {
      // ไม่มี subject context → คงพฤติกรรมเดิม (flatten ทุกชุดแบบราบ)
      for (const [group, questions] of Object.entries(data.question_sets)) {
        for (const q of questions ?? []) push(q, { group });
      }
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
