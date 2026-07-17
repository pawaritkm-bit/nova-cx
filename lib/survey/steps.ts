import { resolveSubjectSet, subjectQuestionCode } from "./schema";

/**
 * สร้าง "ขั้นตอน (steps)" ของ wizard แบบประเมินฝั่ง LIFF จาก schema_json
 *
 * แยกออกมาจาก SurveyClient เพื่อให้ unit test ได้ (ไม่พึ่ง React/CSS)
 * กติกาสำคัญที่ต้องคงไว้ (ห้ามพัง):
 *   - Form B ใช้ per-subject answer key = `<employee_id>__<question_code>`
 *     (สูตรเดียวกับ flattenQuestions ฝั่ง server → validate/scoring ตรงกันเป๊ะ)
 *   - Form A/C/D ใช้ sections ตามลำดับใน schema
 */

// ---- โครง schema (หลวม — มาจาก API) ----
export type Option = { value: string; label: string; is_exclusive?: boolean };
export type Question = {
  code: string;
  text?: string;
  type: "rating" | "single" | "multi" | "open" | "nps";
  scale?: number;
  options?: Option[];
};
export type Section = {
  code?: string;
  title?: string;
  auto_fill?: boolean;
  questions?: Question[];
};
export type SchemaJson = {
  title?: string;
  intro?: string;
  estimated_minutes?: number;
  sections?: Section[];
  question_sets?: Record<string, Question[]>;
  open_questions?: Question[];
};
export type Reference = {
  customer_code: string | null;
  name: string;
  business_name: string | null;
  service_start_date: string | null;
} | null;
export type Subject = {
  employee_id?: string;
  name?: string;
  subject_role?: string;
};

export type ApiTemplate = {
  token: string;
  survey_type: "A" | "B" | "C" | "D";
  survey_slug: string;
  schema: SchemaJson;
  reference: Reference;
  subjects: Subject[];
};

/** กลุ่มคำถามต่อผู้ถูกประเมิน (Form B) — ใช้ render การ์ดแยกคนในหน้าเดียว */
export type StepGroup = { subjectName: string; questions: Question[] };

export type Step = {
  title: string;
  questions: Question[];
  ref?: Reference;
  /** ถ้ามี = หน้านี้แสดงคำถามแบบแยกการ์ดต่อคน (Form B รวมทุกคนในหน้าเดียว) */
  groups?: StepGroup[];
};

/**
 * สร้าง steps จาก schema
 *   - Form A/C/D: 1 step ต่อ 1 section (auto_fill/ref = การ์ดข้อมูลอย่างเดียว)
 *   - Form B: **2 หน้า** →
 *       หน้า 1: ให้ดาวนักบัญชี "ทุกคน" ในหน้าเดียว (แยกการ์ดต่อคน)
 *       หน้า 2: ช่องความเห็น (open_questions) + consent
 *   - open_questions: เป็น step ท้ายสุด (ช่องความเห็นช่องเดียว)
 */
export function buildSteps(template: ApiTemplate): Step[] {
  const { schema, survey_type, reference } = template;
  const steps: Step[] = [];

  if (schema.sections && schema.sections.length > 0) {
    for (const section of schema.sections) {
      const questions = section.questions ?? [];
      if (section.auto_fill || section.code === "ref") {
        // ส่วนข้อมูลอ้างอิง auto-fill → step แสดงข้อมูลอย่างเดียว
        steps.push({
          title: section.title ?? "ข้อมูลอ้างอิง",
          questions: [],
          ref: reference,
        });
        continue;
      }
      if (questions.length === 0) continue;
      steps.push({ title: section.title ?? "แบบประเมิน", questions });
    }
  }

  // Form B: ประเมินนักบัญชี "ทุกคนในหน้าเดียว" (รวมจาก 1 step/คน → 1 step)
  //   answer key = <employee_id>__<question_code> (สูตรเดียวกับ flattenQuestions ฝั่ง server)
  //   เพื่อให้ validate/scoring ฝั่ง server ตรงกับที่ client ส่งเป๊ะ
  if (survey_type === "B" && schema.question_sets) {
    const subjects = (template.subjects ?? []).filter((s) => s.employee_id);
    if (subjects.length > 0) {
      const groups: StepGroup[] = [];
      const allQuestions: Question[] = [];
      for (const subject of subjects) {
        const set = resolveSubjectSet(
          schema.question_sets,
          subject.subject_role
        );
        if (set.length === 0) continue;
        const questions = set.map((q) => ({
          ...q,
          code: subjectQuestionCode(subject.employee_id!, q.code),
        }));
        const who = subject.name ?? subject.employee_id!;
        groups.push({ subjectName: who, questions });
        allQuestions.push(...questions);
      }
      if (groups.length > 0) {
        steps.push({
          title: "ให้คะแนนนักบัญชีที่ดูแลคุณ",
          questions: allQuestions,
          groups,
        });
      }
    } else {
      // fallback (invitation ไม่มี subject) — ใช้ชุด member ครั้งเดียว
      const memberSet = schema.question_sets.member ?? [];
      if (memberSet.length > 0) {
        steps.push({ title: "ให้คะแนนผู้ดูแล", questions: memberSet });
      }
    }
  }

  if (schema.open_questions && schema.open_questions.length > 0) {
    steps.push({ title: "ความเห็นเพิ่มเติม", questions: schema.open_questions });
  }

  return steps;
}
