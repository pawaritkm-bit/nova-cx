import { AI_JSON_SCHEMA } from "./schema";
import { OpenAIProvider } from "./openai";

/**
 * AI Provider abstraction — สลับ provider ได้ (default OpenAI) — FR-AI-09
 *   - รับ prompt + json schema → คืน "JSON string" (ยังไม่ validate)
 *   - การ parse/validate/retry/guardrail ทำใน analyze.ts (provider-agnostic)
 */

export type GenerateJsonArgs = {
  system: string;
  user: string;
  /** JSON schema สำหรับ structured output (OpenAI json_schema) */
  jsonSchema: typeof AI_JSON_SCHEMA;
};

export interface AIProvider {
  /** ชื่อ provider (เก็บลง DB: provider) */
  readonly name: string;
  /** ชื่อโมเดล (เก็บลง DB: model) */
  readonly model: string;
  /** สร้าง JSON string ตาม schema (throw เมื่อเรียก API ล้ม) */
  generateJson(args: GenerateJsonArgs): Promise<string>;
}

/** เลือก provider ตาม env (AI_PROVIDER) — default openai */
export function getAIProvider(): AIProvider | null {
  const provider = (process.env.AI_PROVIDER || "openai").toLowerCase();

  switch (provider) {
    case "openai":
    default: {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return null; // ไม่มี key → degrade สุภาพ (job คง pending)
      const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
      return new OpenAIProvider(apiKey, model);
    }
  }
}

/** true เมื่อพร้อมเรียก AI จริง (มี provider + key) */
export function isAIConfigured(): boolean {
  return getAIProvider() !== null;
}
