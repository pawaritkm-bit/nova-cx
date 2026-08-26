type Usage = { promptTokens?: number; outputTokens?: number; totalTokens?: number };
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
export function logAiUsage(source: string, provider: string, model: string, usage?: Usage): void {
  console.info(JSON.stringify({ event: "ai_usage", source, provider, model,
    promptTokens: usage?.promptTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null }));
}
