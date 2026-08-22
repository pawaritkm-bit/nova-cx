/**
 * doc-purpose.ts — ให้ AI ตีความว่า "ลูกค้าส่งเอกสารนี้มาทำไม" จากบริบทแชท + ชนิดเอกสาร
 *   ★ best-effort: ไม่มี OPENAI_API_KEY / error / เดาไม่ได้ → คืน "" (ไม่ใส่บรรทัดจุดประสงค์)
 *   ★ PDPA: ส่งเฉพาะข้อความแชทล่าสุด (ในกลุ่มลูกค้ารายนั้น) ให้ตีความ — ไม่ log เนื้อหา
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptField } from "@/lib/crypto/field";
import { generateTextWithGemini } from "@/lib/ai/gemini-extract";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.ACCT_DIGITAL_MODEL || "gpt-5-mini";
const TIMEOUT_MS = 20000;

/** รวมข้อความแชทล่าสุด (decrypt) ในกลุ่มนี้ → context ให้ AI · best-effort */
export async function gatherRecentChatText(db: SupabaseClient, chatGroupId: string, limit = 15): Promise<string> {
  try {
    const { data } = await db
      .from("chat_messages")
      .select("content_enc")
      .eq("chat_group_id", chatGroupId)
      .eq("message_type", "text")
      .order("sent_at", { ascending: false })
      .limit(limit);
    const msgs: string[] = [];
    for (const row of (data as { content_enc: string | null }[] | null) ?? []) {
      if (!row.content_enc) continue;
      try {
        const t = decryptField(row.content_enc).trim();
        if (t) msgs.push(t);
      } catch {
        /* ข้าม */
      }
    }
    return msgs.reverse().join("\n").slice(0, 3000); // เก่า→ใหม่, จำกัดความยาว
  } catch {
    return "";
  }
}

const DOCTYPE_LABEL: Record<string, string> = {
  statement: "สเตทเมนต์ธนาคาร",
  platform: "รายงานยอดขายแพลตฟอร์ม (Shopee/TikTok/Lazada)",
  other: "เอกสาร",
};

/**
 * ตีความจุดประสงค์ที่ลูกค้าส่งเอกสาร → 1 ประโยคภาษาไทย · เดาไม่ได้/ไม่มี key → ""
 */
export async function interpretDocPurpose(params: {
  chatText: string;
  docType: string;
  docName?: string | null;
}): Promise<string> {
  const label = DOCTYPE_LABEL[params.docType] || "เอกสาร";
  const prompt =
    `คุณเป็นผู้ช่วยสำนักงานบัญชี ลูกค้าส่ง "${label}" เข้ามาในแชท` +
    (params.docName ? ` (ชื่อไฟล์: ${params.docName})` : "") +
    `\n\nบทสนทนาล่าสุดในแชท:\n${params.chatText || "(ไม่มีข้อความ)"}` +
    `\n\nสรุปสั้นๆ 1 ประโยคภาษาไทยว่า "ลูกค้าส่งเอกสารนี้มาเพื่ออะไร" (เช่น ส่งให้ทำบัญชี/ปิดงบเดือน, เตรียมยื่นภาษี, ขอสินเชื่อ, ตรวจสอบรายรับ). ถ้าเดาไม่ได้จากบริบทให้ตอบว่า "ไม่ระบุ" เท่านั้น ห้ามแต่งเพิ่ม`;
  const clean = (s: string) => {
    const out = (s || "").replace(/\s+/g, " ").trim();
    return !out || out === "ไม่ระบุ" ? "" : out.slice(0, 200);
  };
  // Gemini ก่อน (ถูก + ไม่พึ่ง OpenAI) · ล้ม/ไม่มี key → OpenAI
  const g = await generateTextWithGemini({ system: "ตอบสั้น กระชับ ภาษาไทย", userPrompt: prompt, maxOutputTokens: 300, timeoutMs: TIMEOUT_MS });
  if (g !== null) return clean(g);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "";
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
  };
  if (/^(gpt-5|o\d)/.test(MODEL)) body.max_completion_tokens = 300;
  else { body.temperature = 0; body.max_tokens = 120; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return "";
    const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const out = (json.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim();
    if (!out || out === "ไม่ระบุ") return "";
    return out.slice(0, 200);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
