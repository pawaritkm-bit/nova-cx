import { z } from "zod";

/**
 * Output schema ของการวิเคราะห์ "แชต 1-1 ฝั่งลูกค้า" (Phase A — office inbound)
 *   ★ แยกคนละไฟล์กับ chat-schema.ts (กลุ่ม/per-accountant) และ schema.ts (survey)
 *
 * ข้อจำกัด LINE: 1-1 เห็นเฉพาะข้อความ "ขาเข้าจากลูกค้า" — วิเคราะห์ "ฝั่งลูกค้า" ล้วน
 *   ห้ามประเมินนักบัญชี/flow งาน (นั่นเป็นเรื่องของ chat-schema สำหรับกลุ่ม)
 *
 *   - summary        : สรุปสั้นว่าลูกค้าต้องการ/พูดถึงอะไร (ภาษาไทย)
 *   - sentiment      : อารมณ์ลูกค้า positive|neutral|negative
 *   - urgency        : ความเร่งด่วน critical|high|medium|low
 *   - topics         : หัวข้อที่ลูกค้าพูดถึง (คำสั้น ๆ)
 *   - is_complaint   : เป็นการร้องเรียน/ตำหนิหรือไม่
 *   - needs_attention: ต้องให้เจ้าหน้าที่ดูด่วนหรือไม่ (โมโห/เร่งด่วน/ร้องเรียน)
 *   - confidence     : ความมั่นใจโดยรวม (0..1)
 *   - insufficient_data : true เมื่อข้อความสั้น/ไม่มีบริบทพอ
 *
 * หมายเหตุ: needs_human_review / validated worker เป็นผู้ตัดสิน (ไม่อยู่ใน schema ที่ AI ผลิต)
 */

export const OFFICE_SENTIMENTS = ["positive", "neutral", "negative"] as const;
export const OFFICE_URGENCIES = ["critical", "high", "medium", "low"] as const;

export type OfficeSentiment = (typeof OFFICE_SENTIMENTS)[number];
export type OfficeUrgency = (typeof OFFICE_URGENCIES)[number];

export const officeOutputSchema = z.object({
  summary: z.string().min(1),
  sentiment: z.enum(OFFICE_SENTIMENTS),
  urgency: z.enum(OFFICE_URGENCIES),
  topics: z.array(z.string()),
  is_complaint: z.boolean(),
  needs_attention: z.boolean(),
  confidence: z.number().min(0).max(1),
  insufficient_data: z.boolean(),
});

export type OfficeOutput = z.infer<typeof officeOutputSchema>;

/** ผลสุดท้ายหลัง worker เติม flag — ตรงกับที่บันทึกลง office_inbound_analysis */
export type OfficeAnalysisResult = OfficeOutput & {
  needs_human_review: boolean;
  validated: boolean;
};

/**
 * JSON Schema สำหรับ OpenAI Structured Outputs (strict mode)
 *   - additionalProperties:false + required ครบทุก key (ข้อบังคับ strict)
 */
export const OFFICE_AI_JSON_SCHEMA = {
  name: "nova_office_inbound_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      sentiment: { type: "string", enum: [...OFFICE_SENTIMENTS] },
      urgency: { type: "string", enum: [...OFFICE_URGENCIES] },
      topics: { type: "array", items: { type: "string" } },
      is_complaint: { type: "boolean" },
      needs_attention: { type: "boolean" },
      confidence: { type: "number" },
      insufficient_data: { type: "boolean" },
    },
    required: [
      "summary",
      "sentiment",
      "urgency",
      "topics",
      "is_complaint",
      "needs_attention",
      "confidence",
      "insufficient_data",
    ],
  },
} as const;

/** parse + validate JSON string จาก AI → OfficeOutput (throw ถ้าไม่ผ่าน) */
export function parseOfficeOutput(raw: string): OfficeOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("office_output_not_json");
  }
  return officeOutputSchema.parse(json);
}
