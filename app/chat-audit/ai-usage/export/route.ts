import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import { listAiUsageRows, resolveUsageDateRange } from "@/lib/ai/usage-report";
import { buildAiUsageWorkbook } from "@/lib/ai/usage-excel";

export const dynamic = "force-dynamic";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function GET(req: Request) {
  if (!getSupabaseEnv()) return NextResponse.json({ error: "db_unavailable" }, { status: 503 });
  try {
    const auth = await createClient();
    const ctx = await resolveAdminContext(auth);
    if (!ctx.hasSession) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!ctx.isAdmin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const url = new URL(req.url);
    const range = resolveUsageDateRange(url.searchParams.get("from") || undefined, url.searchParams.get("to") || undefined, 7);
    const rows = await listAiUsageRows(createServiceRoleClient(), range.fromIso, range.untilIso, 50_000);
    const xlsx = await buildAiUsageWorkbook(rows, range.from, range.to);
    const filename = `nova-cx-ai-usage-${range.from}-to-${range.to}.xlsx`;
    return new NextResponse(xlsx as unknown as BodyInit, { headers: {
      "content-type": XLSX,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    }});
  } catch {
    return NextResponse.json({ error: "export_failed", message: "Export รายงานไม่สำเร็จ" }, { status: 500 });
  }
}
