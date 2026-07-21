import { z } from "zod";

/**
 * Output schema ของการสกัด "คู่ถาม-ตอบ" จากแชตกลุ่ม (Phase 1 — Reply Knowledge)
 *   ★ แยกคนละไฟล์กับ chat-schema.ts (ประเมินกลุ่ม) และ office-schema.ts (1-1)
 *
 * เป้าหมาย: ดึงคู่ที่ "ลูกค้าถาม แล้วพนักงานตอบ" ออกมาเป็นความรู้ (แพตเทิร์นคำตอบของทีม)
 *   ★ เฟสนี้เก็บ+เรียนรู้เท่านั้น — ไม่ร่างคำตอบใหม่ ไม่ตอบลูกค้า
 *
 * โครง output = object { pairs: [...] } (OpenAI Structured Outputs ต้องการ object ที่ root)
 *   แต่ละคู่:
 *   - category       : หมวดหมู่ (AI จัดเอง เป็นภาษาไทย open set เช่น ภาษี/เอกสาร/ชำระเงิน/นัดหมาย/ทั่วไป)
 *   - question_gist   : คำถาม/สิ่งที่ลูกค้าต้องการ แบบสรุปสั้น (ไม่มี PII ระบุตัวตน)
 *   - answer_gist     : "แนวทาง/แพตเทิร์น" คำตอบของทีม แบบสรุป (ไม่ใช่ข้อมูลเฉพาะลูกค้า)
 *   - answer_msg_idx  : ลำดับข้อความ (msg_idx) ของ "คำตอบพนักงาน" ที่เป็นตัวแทนคู่นี้
 *                       (ให้ worker resolve ว่าใครเป็นผู้ตอบ — null ถ้าอ้างไม่ได้)
 *   - confidence      : ความมั่นใจว่าเป็นคู่ถาม-ตอบจริง (0..1)
 */

export const knowledgePairSchema = z.object({
  category: z.string().min(1),
  question_gist: z.string().min(1),
  answer_gist: z.string().min(1),
  answer_msg_idx: z.number().int().nonnegative().nullable(),
  confidence: z.number().min(0).max(1),
});

export type KnowledgePair = z.infer<typeof knowledgePairSchema>;

export const knowledgeOutputSchema = z.object({
  pairs: z.array(knowledgePairSchema),
});

export type KnowledgeOutput = z.infer<typeof knowledgeOutputSchema>;

/**
 * JSON Schema สำหรับ OpenAI Structured Outputs (strict mode)
 *   - additionalProperties:false + required ครบทุก key (ข้อบังคับ strict)
 *   - answer_msg_idx เป็น ["integer","null"] เพื่อให้ AI ตอบ null ได้เมื่ออ้างข้อความไม่ได้
 */
export const KNOWLEDGE_AI_JSON_SCHEMA = {
  name: "nova_reply_knowledge_pairs",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pairs: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: { type: "string" },
            question_gist: { type: "string" },
            answer_gist: { type: "string" },
            answer_msg_idx: { type: ["integer", "null"] },
            confidence: { type: "number" },
          },
          required: ["category", "question_gist", "answer_gist", "answer_msg_idx", "confidence"],
        },
      },
    },
    required: ["pairs"],
  },
} as const;

/** parse + validate JSON string จาก AI → KnowledgeOutput (throw ถ้าไม่ผ่าน) */
export function parseKnowledgeOutput(raw: string): KnowledgeOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("knowledge_output_not_json");
  }
  return knowledgeOutputSchema.parse(json);
}
