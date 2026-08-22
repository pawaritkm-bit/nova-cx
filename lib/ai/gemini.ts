import type { AIProvider, GenerateJsonArgs } from "./provider";

/**
 * GeminiProvider — AIProvider ที่ใช้ Gemini (generateContent) แทน OpenAI
 *   ★ คืน "JSON string" (analyze.ts เป็นคน parse/validate/retry — provider-agnostic)
 *   ★ throw เมื่อเรียก API ล้ม (ให้ caller mark job failed/retry เหมือน OpenAIProvider)
 *   ★ PDPA: ไม่ log prompt/คำตอบ — log แค่ error สั้น ๆ
 */
export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  readonly model: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(apiKey: string, model: string, timeoutMs = 60_000) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async generateJson(args: GenerateJsonArgs): Promise<string> {
    const prompt =
      `${args.system}\n\n${args.user}\n\n` +
      `ตอบเป็น JSON เท่านั้น (ไม่มีข้อความอื่น ไม่มี markdown) ให้ตรงกับ schema ชื่อ "${args.jsonSchema.name}" โครงสร้าง:\n` +
      JSON.stringify(args.jsonSchema.schema);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8000 },
        }),
      });
      if (!res.ok) {
        console.warn(`[gemini-provider] http ${res.status}`);
        throw new Error(`gemini http ${res.status}`);
      }
      const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("gemini empty response");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}
