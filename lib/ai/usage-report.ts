import type { SupabaseClient } from "@supabase/supabase-js";

export type AiUsageRow = {
  id: number; source: string; provider: string; model: string;
  prompt_tokens: number | null; output_tokens: number | null; total_tokens: number | null;
  estimated_cost_usd: number | string | null; estimated_cost_thb: number | string | null;
  created_at: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function bangkokToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function resolveUsageDateRange(fromRaw?: string, toRaw?: string, fallbackDays = 7) {
  const today = bangkokToday();
  const fallbackFrom = new Date(`${today}T00:00:00+07:00`);
  fallbackFrom.setUTCDate(fallbackFrom.getUTCDate() - Math.max(0, fallbackDays - 1));
  let from = DATE_RE.test(fromRaw || "") ? fromRaw! : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(fallbackFrom);
  let to = DATE_RE.test(toRaw || "") ? toRaw! : today;
  if (from > to) [from, to] = [to, from];
  const fromIso = new Date(`${from}T00:00:00+07:00`).toISOString();
  const until = new Date(`${to}T00:00:00+07:00`);
  until.setUTCDate(until.getUTCDate() + 1);
  return { from, to, fromIso, untilIso: until.toISOString() };
}

export async function listAiUsageRows(db: SupabaseClient, fromIso: string, untilIso: string, maxRows = 10_000): Promise<AiUsageRow[]> {
  const rows: AiUsageRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await db.from("ai_usage_logs")
      .select("id,source,provider,model,prompt_tokens,output_tokens,total_tokens,estimated_cost_usd,estimated_cost_thb,created_at")
      .gte("created_at", fromIso).lt("created_at", untilIso)
      .order("created_at", { ascending: false }).range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as AiUsageRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
