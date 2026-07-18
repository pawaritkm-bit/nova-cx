/**
 * อ่าน "ภาพรวมแบบประเมิน" แบบ read-only สำหรับหน้า /surveys
 *
 * ★ ไฟล์นี้เป็นชั้น "อ่านเพื่อแสดงผล" ของ config ฟอร์ม (A/B/C/D) เท่านั้น
 *   ไม่ใช่ runtime survey logic (นั่นอยู่ที่ lib/survey/*) — จึงไม่แตะตรรกะการส่ง/ตอบฟอร์ม
 *   ข้อมูล template/version/question เป็น "config" ไม่ใช่ PII จึงอ่านด้วย service-role
 *   โดย scope ด้วย tenant จาก session ที่ caller ส่งเข้ามาเสมอ
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { SURVEY_TYPES, type SurveyType } from "@/lib/survey/types";

type DB = SupabaseClient;

/** ป้ายรอบ/ความถี่การส่งของแต่ละฟอร์ม (อ่านง่ายสำหรับผู้ดูแล) */
const FREQUENCY_LABEL: Record<SurveyType, string> = {
  A: "ราย 3 เดือน · ส่งเป็นกลุ่ม (แบบประเมินสำนักงาน)",
  B: "รายเดือน (แบบประเมินนักบัญชี)",
  C: "เมื่อปิดการขายได้ (ตอนปิดดีล)",
  D: "เมื่อปิดการขายไม่ได้ (ตอนปิดดีล)",
};

export type SurveyQuestionView = {
  code: string;
  text: string;
  type: string;
  orderNo: number;
};

export type SurveyFormOverview = {
  surveyType: SurveyType;
  name: string;
  isActive: boolean;
  frequencyLabel: string;
  /** เวอร์ชันล่าสุด (null = ยังไม่มี version) */
  versionNo: number | null;
  publishedAt: string | null;
  questionCount: number;
  questions: SurveyQuestionView[];
};

export type SurveyCampaignView = {
  surveyType: SurveyType;
  cycleLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
};

export type SurveyOverview = {
  forms: SurveyFormOverview[];
  campaigns: SurveyCampaignView[];
};

type TemplateRow = {
  id: string;
  survey_type: string;
  name: string;
  is_active: boolean;
};

type VersionRow = {
  id: string;
  template_id: string;
  version_no: number;
  published_at: string | null;
  schema_json: unknown;
};

type QuestionRow = {
  version_id: string;
  code: string;
  text: string;
  type: string;
  order_no: number;
};

/**
 * ดึงคำถามจาก schema_json (versioned JSON) มา flatten เป็นรายการเดียว
 * ใช้เป็น fallback เมื่อตาราง survey_questions (normalized) ยังไม่ถูก populate
 * — เดินลง sections[].questions[] แบบระวังชนิดข้อมูล (config มาจาก DB ถือว่า trusted แต่กันพัง)
 */
function flattenSchemaQuestions(schema: unknown): SurveyQuestionView[] {
  if (!schema || typeof schema !== "object") return [];
  const sections = (schema as { sections?: unknown }).sections;
  if (!Array.isArray(sections)) return [];

  const out: SurveyQuestionView[] = [];
  let order = 0;
  for (const section of sections) {
    const questions = (section as { questions?: unknown })?.questions;
    if (!Array.isArray(questions)) continue;
    for (const q of questions) {
      const code = (q as { code?: unknown })?.code;
      const text = (q as { text?: unknown })?.text;
      const type = (q as { type?: unknown })?.type;
      if (typeof code !== "string" || typeof text !== "string") continue;
      out.push({
        code,
        text,
        type: typeof type === "string" ? type : "open",
        orderNo: order++,
      });
    }
  }
  return out;
}

/**
 * ประกอบภาพรวมฟอร์ม A/B/C/D + แคมเปญ (ถ้ามี)
 * - ทุก query scope ด้วย tenantId (จาก session) เสมอ
 * - อ่านไม่สำเร็จบางส่วน → ปล่อยเป็นค่าว่าง/degrade ไม่ throw ทั้งหน้า
 */
export async function getSurveyOverview(
  db: DB,
  tenantId: string
): Promise<SurveyOverview> {
  // 1) templates ทั้ง 4 ประเภท
  const { data: templateData } = await db
    .from("survey_templates")
    .select("id, survey_type, name, is_active")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  const templates = (templateData ?? []) as TemplateRow[];

  // 2) versions ทั้งหมด (จะเลือกตัว version_no สูงสุดต่อ template)
  const { data: versionData } = await db
    .from("survey_versions")
    .select("id, template_id, version_no, published_at, schema_json")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("version_no", { ascending: false });
  const versions = (versionData ?? []) as VersionRow[];

  // version ล่าสุดต่อ template (แถวแรกที่เจอ = version_no สูงสุด เพราะ order desc)
  const latestByTemplate = new Map<string, VersionRow>();
  for (const v of versions) {
    if (!latestByTemplate.has(v.template_id)) latestByTemplate.set(v.template_id, v);
  }

  const latestVersionIds = [...latestByTemplate.values()].map((v) => v.id);

  // 3) คำถาม normalized ของ version ล่าสุด (ถ้ามี)
  const questionsByVersion = new Map<string, SurveyQuestionView[]>();
  if (latestVersionIds.length > 0) {
    const { data: questionData } = await db
      .from("survey_questions")
      .select("version_id, code, text, type, order_no")
      .in("version_id", latestVersionIds)
      .is("deleted_at", null)
      .order("order_no", { ascending: true });
    for (const q of (questionData ?? []) as QuestionRow[]) {
      const list = questionsByVersion.get(q.version_id) ?? [];
      list.push({ code: q.code, text: q.text, type: q.type, orderNo: q.order_no });
      questionsByVersion.set(q.version_id, list);
    }
  }

  // template ต่อ survey_type (มีได้ 1 ต่อ type ตาม unique constraint)
  const templateByType = new Map<string, TemplateRow>();
  for (const t of templates) templateByType.set(t.survey_type, t);

  // 4) ประกอบการ์ดฟอร์มให้ครบ A/B/C/D เสมอ (ไม่มีในฐานข้อมูล = แสดง "ยังไม่ตั้งค่า")
  const forms: SurveyFormOverview[] = SURVEY_TYPES.map((type) => {
    const template = templateByType.get(type);
    const version = template ? latestByTemplate.get(template.id) : undefined;

    let questions: SurveyQuestionView[] = [];
    if (version) {
      questions = questionsByVersion.get(version.id) ?? [];
      // fallback: normalized ว่าง → ดึงจาก schema_json เพื่อให้ยังเห็นคำถามได้
      if (questions.length === 0) questions = flattenSchemaQuestions(version.schema_json);
    }

    return {
      surveyType: type,
      name: template?.name ?? `แบบประเมิน ${type} (ยังไม่ตั้งค่า)`,
      isActive: template?.is_active ?? false,
      frequencyLabel: FREQUENCY_LABEL[type],
      versionNo: version?.version_no ?? null,
      publishedAt: version?.published_at ?? null,
      questionCount: questions.length,
      questions,
    };
  });

  // 5) แคมเปญ (ถ้ามีตาราง/ข้อมูล) — ไม่มีก็คืน []
  let campaigns: SurveyCampaignView[] = [];
  const { data: campaignData } = await db
    .from("survey_campaigns")
    .select("survey_type, cycle_label, period_start, period_end")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  campaigns = ((campaignData ?? []) as {
    survey_type: string;
    cycle_label: string;
    period_start: string | null;
    period_end: string | null;
  }[]).map((c) => ({
    surveyType: c.survey_type as SurveyType,
    cycleLabel: c.cycle_label,
    periodStart: c.period_start,
    periodEnd: c.period_end,
  }));

  return { forms, campaigns };
}
