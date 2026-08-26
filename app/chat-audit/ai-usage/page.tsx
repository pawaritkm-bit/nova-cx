import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import ChatAuditFrame from "../_Frame";

export const dynamic = "force-dynamic";

type UsageRow = {
  id: number;
  source: string;
  provider: string;
  model: string;
  prompt_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | string | null;
  estimated_cost_thb: number | string | null;
  created_at: string;
};

const SOURCE_LABELS: Record<string, string> = {
  bill_classify: "คัดประเภทรูป/บิล",
  bill_extract: "อ่านข้อมูลบิล",
  bill_verify: "ตรวจทานบิลยาก",
  statement_extract: "อ่าน Statement",
  platform_report_extract: "อ่านรายงานแพลตฟอร์ม",
  id_card_extract: "อ่านบัตรประชาชน",
  document_purpose: "วิเคราะห์วัตถุประสงค์เอกสาร",
  finance_document_classify: "คัดประเภทเอกสารการเงิน",
  share_circle_classify: "คัดลิสต์วงแชร์",
};

function money(v: number): string {
  return new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v);
}

export default async function AiUsagePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  if (!getSupabaseEnv()) redirect("/login?redirect=/chat-audit/ai-usage");
  const auth = await createClient();
  const ctx = await resolveAdminContext(auth);
  if (!ctx.hasSession) redirect("/login?redirect=/chat-audit/ai-usage");
  if (!ctx.isAdmin) {
    return <ChatAuditFrame active="ai-usage" role={ctx.role} authed={true} title="การใช้ AI" subtitle="Token และค่าใช้จ่าย"><div className="card">หน้านี้เปิดเฉพาะ Admin และผู้บริหาร</div></ChatAuditFrame>;
  }

  const sp = await searchParams;
  const requested = Number(sp.days || 7);
  const days = [1, 7, 30, 90].includes(requested) ? requested : 7;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let rows: UsageRow[] = [];
  let loadError = false;
  try {
    const db = createServiceRoleClient();
    const { data, error } = await db.from("ai_usage_logs").select("id,source,provider,model,prompt_tokens,output_tokens,total_tokens,estimated_cost_usd,estimated_cost_thb,created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(2000);
    if (error) throw error;
    rows = (data ?? []) as UsageRow[];
  } catch {
    loadError = true;
  }

  const totalTokens = rows.reduce((s, r) => s + (r.total_tokens ?? 0), 0);
  const totalThb = rows.reduce((s, r) => s + Number(r.estimated_cost_thb ?? 0), 0);
  const bySource = new Map<string, { calls: number; tokens: number; thb: number }>();
  for (const row of rows) {
    const item = bySource.get(row.source) ?? { calls: 0, tokens: 0, thb: 0 };
    item.calls++;
    item.tokens += row.total_tokens ?? 0;
    item.thb += Number(row.estimated_cost_thb ?? 0);
    bySource.set(row.source, item);
  }
  const ranked = [...bySource.entries()].sort((a, b) => b[1].thb - a[1].thb);

  return (
    <ChatAuditFrame active="ai-usage" role={ctx.role} authed={true} title="การใช้ AI" subtitle="ดูโมเดล · ฟังก์ชัน · Token · ค่าใช้จ่ายโดยประมาณ">
      <section style={{ display: "grid", gap: 16 }}>
        <div className="card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <strong>ช่วงเวลา:</strong>
          {[1, 7, 30, 90].map((d) => <Link key={d} className={`btn${days === d ? " primary" : ""}`} href={`/chat-audit/ai-usage?days=${d}`}>{d} วัน</Link>)}
          <span className="muted" style={{ marginLeft: "auto" }}>ค่าใช้จ่ายเป็นค่าประมาณและไม่เก็บเนื้อหาเอกสาร</span>
        </div>
        {loadError ? <div className="card">ยังอ่านประวัติไม่ได้ — กรุณา apply migration 0122_ai_usage_logs.sql</div> : null}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 12 }}>
          <div className="card"><div className="muted">เรียก AI</div><div style={{ fontSize: 28, fontWeight: 800 }}>{rows.length.toLocaleString("th-TH")} ครั้ง</div></div>
          <div className="card"><div className="muted">Token รวม</div><div style={{ fontSize: 28, fontWeight: 800 }}>{totalTokens.toLocaleString("th-TH")}</div></div>
          <div className="card"><div className="muted">ค่าใช้จ่ายประมาณ</div><div style={{ fontSize: 28, fontWeight: 800 }}>฿{money(totalThb)}</div></div>
          <div className="card"><div className="muted">เฉลี่ยต่อครั้ง</div><div style={{ fontSize: 28, fontWeight: 800 }}>฿{money(rows.length ? totalThb / rows.length : 0)}</div></div>
        </div>
        <div className="card" style={{ overflowX: "auto" }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, marginBottom: 12 }}>ค่าใช้จ่ายแยกตามฟังก์ชัน</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr><th align="left">ฟังก์ชัน</th><th align="right">ครั้ง</th><th align="right">Token</th><th align="right">ประมาณ</th></tr></thead>
            <tbody>{ranked.map(([source, v]) => <tr key={source}><td>{SOURCE_LABELS[source] ?? source}</td><td align="right">{v.calls.toLocaleString("th-TH")}</td><td align="right">{v.tokens.toLocaleString("th-TH")}</td><td align="right">฿{money(v.thb)}</td></tr>)}</tbody></table>
        </div>
        <div className="card" style={{ overflowX: "auto" }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, marginBottom: 12 }}>รายการล่าสุด</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}><thead><tr><th align="left">เวลา</th><th align="left">ฟังก์ชัน</th><th align="left">โมเดล</th><th align="right">Input</th><th align="right">Output</th><th align="right">รวม</th><th align="right">ประมาณ</th></tr></thead>
            <tbody>{rows.slice(0, 200).map((r) => <tr key={r.id}><td>{new Date(r.created_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}</td><td>{SOURCE_LABELS[r.source] ?? r.source}</td><td>{r.provider} / {r.model}</td><td align="right">{r.prompt_tokens?.toLocaleString("th-TH") ?? "-"}</td><td align="right">{r.output_tokens?.toLocaleString("th-TH") ?? "-"}</td><td align="right">{r.total_tokens?.toLocaleString("th-TH") ?? "-"}</td><td align="right">฿{money(Number(r.estimated_cost_thb ?? 0))}</td></tr>)}</tbody></table>
          {!loadError && rows.length === 0 ? <p className="muted" style={{ marginTop: 12 }}>ยังไม่มีการเรียก AI ในช่วงเวลานี้</p> : null}
        </div>
      </section>
    </ChatAuditFrame>
  );
}
