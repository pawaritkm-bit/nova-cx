import type { AIProvider, GenerateJsonArgs } from "./provider";
import { logAiUsage, reserveAiCall } from "./usage-budget";

/**
 * OpenAI adapter — ใช้ Chat Completions + Structured Outputs (response_format=json_schema)
 *   - เรียกผ่าน fetch ตรง (ไม่เพิ่ม dependency) — อ่าน key จาก env เท่านั้น (ไม่ hardcode)
 *   - บังคับ structured JSON: strict json_schema → ลดโอกาส parse ไม่ผ่าน
 *   - timeout กันค้าง (AbortController)
 */

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 60_000;

type ChatCompletionResponse = {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generateJson(args: GenerateJsonArgs): Promise<string> {
    const source = `structured_${args.jsonSchema.name}`;
    if (!reserveAiCall(source, this.model)) throw new Error("ai_budget_block");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          messages: [
            { role: "system", content: args.system },
            { role: "user", content: args.user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: args.jsonSchema,
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ChatCompletionResponse | null;
        const msg = body?.error?.message || `HTTP ${res.status}`;
        throw new Error(`openai_error: ${msg}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;
      logAiUsage(source, "openai", this.model, {
        promptTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
        totalTokens: data.usage?.total_tokens,
      });
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("openai_empty_response");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
