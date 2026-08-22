import { OpenAIProvider } from "./openai";
import { GeminiProvider } from "./gemini";

/**
 * AI Provider abstraction — สลับ provider ได้ (default OpenAI) — FR-AI-09
 *   - รับ prompt + json schema → คืน "JSON string" (ยังไม่ validate)
 *   - การ parse/validate/retry/guardrail ทำใน analyze.ts (provider-agnostic)
 */

/**
 * รูป JSON schema spec สำหรับ OpenAI Structured Outputs (response_format=json_schema)
 *   กว้างพอให้ทั้ง schema ของ survey (AI_JSON_SCHEMA) และ chat (CHAT_AI_JSON_SCHEMA) ใช้ร่วมได้
 *   — เพิ่มแบบ additive ไม่ผูกกับ schema ตัวใดตัวหนึ่ง (ไม่ regress survey)
 */
export type JsonSchemaSpec = {
  readonly name: string;
  readonly strict?: boolean;
  readonly schema: Record<string, unknown>;
};

export type GenerateJsonArgs = {
  system: string;
  user: string;
  /** JSON schema สำหรับ structured output (OpenAI json_schema) */
  jsonSchema: JsonSchemaSpec;
};

export interface AIProvider {
  /** ชื่อ provider (เก็บลง DB: provider) */
  readonly name: string;
  /** ชื่อโมเดล (เก็บลง DB: model) */
  readonly model: string;
  /** สร้าง JSON string ตาม schema (throw เมื่อเรียก API ล้ม) */
  generateJson(args: GenerateJsonArgs): Promise<string>;
}

/**
 * เลือก provider ตาม env — ★ default = Gemini เมื่อมี GEMINI_API_KEY (เลิกพึ่ง GPT)
 *   - AI_PROVIDER=openai (บังคับ) → OpenAI
 *   - AI_PROVIDER=gemini หรือไม่ตั้ง + มี GEMINI_API_KEY → Gemini
 *   - ไม่มี Gemini key แต่มี OpenAI key → OpenAI (fallback)
 *   - ไม่มี key เลย → null (degrade สุภาพ · job คง pending)
 */
export function getAIProvider(): AIProvider | null {
  const explicit = (process.env.AI_PROVIDER || "").toLowerCase();
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiModel = process.env.AI_QA_MODEL || process.env.ACCT_VISION_MODEL || "gemini-3.6-flash";

  if (explicit === "openai") {
    if (openaiKey) return new OpenAIProvider(openaiKey, process.env.OPENAI_MODEL || "gpt-4o-mini");
    return geminiKey ? new GeminiProvider(geminiKey, geminiModel) : null;
  }
  // default: Gemini ก่อน (ถ้ามี key) — เลิกพึ่ง GPT
  if (geminiKey) return new GeminiProvider(geminiKey, geminiModel);
  if (openaiKey) return new OpenAIProvider(openaiKey, process.env.OPENAI_MODEL || "gpt-4o-mini");
  return null;
}

/** true เมื่อพร้อมเรียก AI จริง (มี provider + key) */
export function isAIConfigured(): boolean {
  return getAIProvider() !== null;
}
