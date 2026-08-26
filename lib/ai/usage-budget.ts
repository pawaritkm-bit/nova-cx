type Usage = { promptTokens?: number; outputTokens?: number; thinkingTokens?: number; totalTokens?: number };
type WindowState = { hour: string; day: string; hourCalls: number; dayCalls: number };
const shared = globalThis as typeof globalThis & { __novaAiWindow?: WindowState };

function currentWindow(): WindowState {
  const now = new Date();
  const hour = now.toISOString().slice(0, 13);
  const day = now.toISOString().slice(0, 10);
  const state = shared.__novaAiWindow ?? (shared.__novaAiWindow = { hour, day, hourCalls: 0, dayCalls: 0 });
  if (state.hour !== hour) { state.hour = hour; state.hourCalls = 0; }
  if (state.day !== day) { state.day = day; state.dayCalls = 0; }
  return state;
}

/** Emergency cost circuit breaker. Set either env limit to 0 to disable it. */
export function reserveAiCall(source: string, model: string): boolean {
  const state = currentWindow();
  const hourly = Number(process.env.AI_MAX_CALLS_PER_HOUR || 300);
  const daily = Number(process.env.AI_MAX_CALLS_PER_DAY || 3000);
  if ((hourly > 0 && state.hourCalls >= hourly) || (daily > 0 && state.dayCalls >= daily)) {
    console.warn(JSON.stringify({ event: "ai_budget_block", source, model, hourCalls: state.hourCalls, dayCalls: state.dayCalls }));
    return false;
  }
  state.hourCalls++;
  state.dayCalls++;
  return true;
}

/** Content-free usage log for identifying cost by feature/model in Vercel logs. */
export async function logAiUsage(source: string, provider: string, model: string, usage?: Usage): Promise<void> {
  const promptTokens = usage?.promptTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const thinkingTokens = usage?.thinkingTokens ?? Math.max(0, (usage?.totalTokens ?? 0) - promptTokens - outputTokens);
  const usdToThb = Number(process.env.AI_USD_TO_THB || 35);
  // Override ได้จาก Vercel env เมื่อผู้ให้บริการเปลี่ยนราคา
  let inputPerMillion = Number(process.env.AI_INPUT_USD_PER_MILLION || 0);
  let outputPerMillion = Number(process.env.AI_OUTPUT_USD_PER_MILLION || 0);
  if (provider === "gemini" && /gemini-3\.[67]-flash/i.test(model)) {
    inputPerMillion = Number(process.env.GEMINI_FLASH_INPUT_USD_PER_MILLION || 0.75);
    outputPerMillion = Number(process.env.GEMINI_FLASH_OUTPUT_USD_PER_MILLION || 3.75);
  } else if (provider === "gemini" && /gemini-2\.5-flash-lite/i.test(model)) {
    inputPerMillion = Number(process.env.GEMINI_FLASH_LITE_INPUT_USD_PER_MILLION || 0.10);
    outputPerMillion = Number(process.env.GEMINI_FLASH_LITE_OUTPUT_USD_PER_MILLION || 0.40);
  } else if (provider === "gemini" && /gemini-2\.5-flash/i.test(model)) {
    inputPerMillion = Number(process.env.GEMINI_FLASH_INPUT_USD_PER_MILLION || 0.30);
    outputPerMillion = Number(process.env.GEMINI_FLASH_OUTPUT_USD_PER_MILLION || 2.50);
  } else if (provider === "anthropic" && /claude-sonnet-5/i.test(model)) {
    inputPerMillion = Number(process.env.CLAUDE_SONNET_INPUT_USD_PER_MILLION || 2);
    outputPerMillion = Number(process.env.CLAUDE_SONNET_OUTPUT_USD_PER_MILLION || 10);
  }
  const hasPrice = inputPerMillion > 0 || outputPerMillion > 0;
  const billedOutputTokens = provider === "gemini" ? outputTokens + thinkingTokens : outputTokens;
  const estimatedCostUsd = hasPrice ? (promptTokens * inputPerMillion + billedOutputTokens * outputPerMillion) / 1_000_000 : null;
  const estimatedCostThb = estimatedCostUsd == null ? null : estimatedCostUsd * usdToThb;
  const record = { event: "ai_usage", source, provider, model,
    promptTokens: usage?.promptTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    thinkingTokens,
    totalTokens: usage?.totalTokens ?? null,
    estimatedCostUsd: estimatedCostUsd == null ? null : Number(estimatedCostUsd.toFixed(8)),
    estimatedCostThb: estimatedCostThb == null ? null : Number(estimatedCostThb.toFixed(6)),
    priceIsEstimate: true };
  console.info(JSON.stringify(record));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${url}/rest/v1/ai_usage_logs`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        source, provider, model,
        prompt_tokens: record.promptTokens,
        output_tokens: record.outputTokens,
        thinking_tokens: record.thinkingTokens,
        total_tokens: record.totalTokens,
        estimated_cost_usd: record.estimatedCostUsd,
        estimated_cost_thb: record.estimatedCostThb,
        price_is_estimate: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) console.warn(`[ai-usage] persist http ${res.status}`);
  } catch {
    console.warn("[ai-usage] persist error");
  } finally {
    clearTimeout(timer);
  }
}
