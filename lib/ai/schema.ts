import { z } from "zod";

/**
 * Output schema ของน้อง NOVA (structured JSON + Zod validation) — FR-AI-08
 *   - แยก customer_facts (ข้อเท็จจริงลูกค้า) ออกจาก ai_assumptions (ข้อสันนิษฐาน) — C-03
 *   - ทุกข้อสรุปต้องมี evidence อ้างอิงคำพูด — C-03
 *   - urgency 4 ระดับ + urgency_reason (เหตุผล+ข้อมูลที่ใช้จัดระดับ) — FR-AI-05
 *
 * หมายเหตุ: needs_human_review / validated เป็นสิ่งที่ "worker" ตัดสิน ไม่ใช่ AI
 *   (High/Critical บังคับ true, parse ไม่ผ่าน = true) จึงไม่อยู่ใน schema ที่ AI ต้องผลิต
 */

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export const URGENCIES = ["critical", "high", "medium", "positive"] as const;

export type Sentiment = (typeof SENTIMENTS)[number];
export type Urgency = (typeof URGENCIES)[number];

export const evidenceItemSchema = z.object({
  claim: z.string().min(1),
  quote: z.string().min(1),
});

export const affectedSchema = z.object({
  employee: z.string().nullable(),
  team: z.string().nullable(),
  service: z.string().nullable(),
  period: z.string().nullable(),
});

/** schema ของผลลัพธ์ที่ AI ต้องผลิต (ก่อน worker เติม needs_human_review/validated) */
export const aiOutputSchema = z.object({
  summary: z.string().min(1),
  customer_facts: z.array(z.string()),
  ai_assumptions: z.array(z.string()),
  evidence: z.array(evidenceItemSchema),
  categories: z.array(z.string()),
  sentiment: z.enum(SENTIMENTS),
  urgency: z.enum(URGENCIES),
  urgency_reason: z.string().min(1),
  affected: affectedSchema,
  repeat_issue: z.boolean(),
  next_best_action: z.string(),
  draft_reply: z.string(),
  confidence: z.number().min(0).max(1),
});

export type AiOutput = z.infer<typeof aiOutputSchema>;

/** ผลสุดท้ายหลัง worker เติม flag — ตรงกับคอลัมน์ ai_feedback_analysis */
export type AiAnalysisResult = AiOutput & {
  needs_human_review: boolean;
  validated: boolean;
};

/**
 * JSON Schema สำหรับ OpenAI Structured Outputs (response_format=json_schema)
 *   - additionalProperties:false + required ครบทุก key (ข้อบังคับของ strict mode)
 */
export const AI_JSON_SCHEMA = {
  name: "nova_feedback_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      customer_facts: { type: "array", items: { type: "string" } },
      ai_assumptions: { type: "array", items: { type: "string" } },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            claim: { type: "string" },
            quote: { type: "string" },
          },
          required: ["claim", "quote"],
        },
      },
      categories: { type: "array", items: { type: "string" } },
      sentiment: { type: "string", enum: [...SENTIMENTS] },
      urgency: { type: "string", enum: [...URGENCIES] },
      urgency_reason: { type: "string" },
      affected: {
        type: "object",
        additionalProperties: false,
        properties: {
          employee: { type: ["string", "null"] },
          team: { type: ["string", "null"] },
          service: { type: ["string", "null"] },
          period: { type: ["string", "null"] },
        },
        required: ["employee", "team", "service", "period"],
      },
      repeat_issue: { type: "boolean" },
      next_best_action: { type: "string" },
      draft_reply: { type: "string" },
      confidence: { type: "number" },
    },
    required: [
      "summary",
      "customer_facts",
      "ai_assumptions",
      "evidence",
      "categories",
      "sentiment",
      "urgency",
      "urgency_reason",
      "affected",
      "repeat_issue",
      "next_best_action",
      "draft_reply",
      "confidence",
    ],
  },
} as const;

/** parse + validate ผลลัพธ์ JSON string จาก AI → AiOutput (throw ถ้าไม่ผ่าน) */
export function parseAiOutput(raw: string): AiOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("ai_output_not_json");
  }
  return aiOutputSchema.parse(json);
}
