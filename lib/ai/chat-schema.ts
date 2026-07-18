import { z } from "zod";

/**
 * Output schema ของการวิเคราะห์ "บทสนทนากลุ่ม" (Phase 2 — chat analysis)
 *   ★ แยกคนละไฟล์กับ schema.ts ของ survey (ไม่แตะ survey AI)
 *
 *   - แยก customer_facts (ข้อเท็จจริง อ้างข้อความ+เวลา) vs ai_assumptions (สันนิษฐาน)
 *   - evidence อ้างอิงข้อความจริงด้วย msg_idx (ลำดับใน window) + เวลา + quote
 *   - flow_steps : สถานะแต่ละขั้นของ flow งาน (รับเรื่อง→ตอบ→...→ปิด)
 *   - problems   : ปัญหาที่จับได้ (ตอบช้า/ตกหล่น/ไม่มี owner/ขอเอกสารซ้ำ/...)
 *   - sop_violations : ประเด็นผิด SOP (+ needs_expert_review เรื่องบัญชี/ภาษีเสี่ยงสูง)
 *   - sentiment_points : จุดวัดความรู้สึกลูกค้า (ไว้พล็อตเทรนด์)
 *   - insufficient_data : true เมื่อข้อมูลไม่พอสรุป
 *
 * หมายเหตุ: needs_human_review / validated worker เป็นคนตัดสิน (ไม่อยู่ใน schema ที่ AI ผลิต)
 *   msg_idx = ลำดับข้อความใน window (0-based) — worker map กลับเป็น message_id จริง
 */

export const CHAT_SENTIMENTS = ["positive", "neutral", "negative"] as const;
export const CHAT_URGENCIES = ["critical", "high", "medium", "positive"] as const;

export const FLOW_STEPS = [
  "receive", // รับเรื่อง
  "acknowledge", // ตอบรับ
  "response_time", // เวลาตอบ
  "understand", // เข้าใจโจทย์
  "set_deadline", // กำหนดเสร็จ
  "execute", // ดำเนินการ
  "update", // อัปเดตความคืบหน้า
  "close", // ปิดงาน
] as const;

export const FLOW_STATUSES = ["done", "partial", "late", "missing", "unknown"] as const;

export const PROBLEM_TYPES = [
  "slow_reply", // ตอบช้า
  "missed_request", // ตกหล่น
  "no_owner", // ไม่มีผู้รับผิดชอบ
  "repeat_doc_request", // ขอเอกสารซ้ำ
  "off_topic_reply", // ตอบไม่ตรง
  "jargon", // ศัพท์ยาก
  "terse_reply", // ตอบห้วน
  "conflicting_info", // ข้อมูลขัดแย้ง
  "other",
] as const;

export const VIOLATION_SEVERITIES = ["low", "medium", "high"] as const;

export type ChatSentiment = (typeof CHAT_SENTIMENTS)[number];
export type ChatUrgency = (typeof CHAT_URGENCIES)[number];

// --- Zod schema (post-validate ผลจาก AI) ---

const evidenceItemSchema = z.object({
  claim: z.string().min(1),
  quote: z.string().min(1),
  msg_idx: z.number().int().nullable(),
});

const flowStepSchema = z.object({
  step: z.enum(FLOW_STEPS),
  status: z.enum(FLOW_STATUSES),
  note: z.string(),
  msg_idx: z.number().int().nullable(),
});

const problemSchema = z.object({
  type: z.enum(PROBLEM_TYPES),
  detail: z.string(),
  msg_idx: z.number().int().nullable(),
});

const sopViolationSchema = z.object({
  violation_type: z.enum(PROBLEM_TYPES),
  severity: z.enum(VIOLATION_SEVERITIES),
  description: z.string(),
  msg_idx: z.number().int().nullable(),
  needs_expert_review: z.boolean(),
});

const sentimentPointSchema = z.object({
  score: z.number().min(-1).max(1),
  label: z.enum(CHAT_SENTIMENTS),
  msg_idx: z.number().int().nullable(),
});

export const chatOutputSchema = z.object({
  summary: z.string().min(1),
  customer_facts: z.array(z.string()),
  ai_assumptions: z.array(z.string()),
  evidence: z.array(evidenceItemSchema),
  flow_steps: z.array(flowStepSchema),
  problems: z.array(problemSchema),
  sop_violations: z.array(sopViolationSchema),
  sentiment_points: z.array(sentimentPointSchema),
  sentiment: z.enum(CHAT_SENTIMENTS),
  urgency: z.enum(CHAT_URGENCIES),
  confidence: z.number().min(0).max(1),
  insufficient_data: z.boolean(),
});

export type ChatOutput = z.infer<typeof chatOutputSchema>;

/** ผลสุดท้ายหลัง worker เติม flag — ตรงกับที่บันทึกลง ai_chat_analysis */
export type ChatAnalysisResult = ChatOutput & {
  needs_human_review: boolean;
  validated: boolean;
};

/**
 * JSON Schema สำหรับ OpenAI Structured Outputs (strict mode)
 *   - additionalProperties:false + required ครบทุก key (ข้อบังคับ strict)
 */
export const CHAT_AI_JSON_SCHEMA = {
  name: "nova_chat_analysis",
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
            msg_idx: { type: ["integer", "null"] },
          },
          required: ["claim", "quote", "msg_idx"],
        },
      },
      flow_steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            step: { type: "string", enum: [...FLOW_STEPS] },
            status: { type: "string", enum: [...FLOW_STATUSES] },
            note: { type: "string" },
            msg_idx: { type: ["integer", "null"] },
          },
          required: ["step", "status", "note", "msg_idx"],
        },
      },
      problems: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: [...PROBLEM_TYPES] },
            detail: { type: "string" },
            msg_idx: { type: ["integer", "null"] },
          },
          required: ["type", "detail", "msg_idx"],
        },
      },
      sop_violations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            violation_type: { type: "string", enum: [...PROBLEM_TYPES] },
            severity: { type: "string", enum: [...VIOLATION_SEVERITIES] },
            description: { type: "string" },
            msg_idx: { type: ["integer", "null"] },
            needs_expert_review: { type: "boolean" },
          },
          required: ["violation_type", "severity", "description", "msg_idx", "needs_expert_review"],
        },
      },
      sentiment_points: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            score: { type: "number" },
            label: { type: "string", enum: [...CHAT_SENTIMENTS] },
            msg_idx: { type: ["integer", "null"] },
          },
          required: ["score", "label", "msg_idx"],
        },
      },
      sentiment: { type: "string", enum: [...CHAT_SENTIMENTS] },
      urgency: { type: "string", enum: [...CHAT_URGENCIES] },
      confidence: { type: "number" },
      insufficient_data: { type: "boolean" },
    },
    required: [
      "summary",
      "customer_facts",
      "ai_assumptions",
      "evidence",
      "flow_steps",
      "problems",
      "sop_violations",
      "sentiment_points",
      "sentiment",
      "urgency",
      "confidence",
      "insufficient_data",
    ],
  },
} as const;

/** parse + validate JSON string จาก AI → ChatOutput (throw ถ้าไม่ผ่าน) */
export function parseChatOutput(raw: string): ChatOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("chat_output_not_json");
  }
  return chatOutputSchema.parse(json);
}
