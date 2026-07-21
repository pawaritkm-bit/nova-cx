import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { isAdminRole } from "@/lib/admin/guard";
import { getOfficeDashboard, type OfficeDashboard } from "@/lib/office/queries";
import ChatAuditFrame from "../_Frame";

export const dynamic = "force-dynamic";

const DEV_FALLBACK = process.env.NODE_ENV !== "production";
const TITLE = "ตรวจแชต · ประเมินสำนักงาน";
const SUBTITLE =
  "ภาพรวมแชต 1-1 ฝั่งลูกค้า (Office CX) — สัญญาณลูกค้าขาเข้า · ร้องเรียน · เรื่องด่วน (ไม่เกี่ยวกับประเมินนักบัญชีรายคน)";

/** ช่วงเวลาให้เลือก (วัน) — null = ทั้งหมด */
const RANGE_OPTIONS: { key: string; label: string; days: number | null }[] = [
  { key: "7", label: "7 วัน", days: 7 },
  { key: "30", label: "30 วัน", days: 30 },
  { key: "90", label: "90 วัน", days: 90 },
  { key: "all", label: "ทั้งหมด", days: null },
];
const DEFAULT_RANGE = "30";

const SENTIMENT_LABEL: Record<string, string> = {
  positive: "พอใจ",
  neutral: "เฉย ๆ",
  negative: "ไม่พอใจ",
};

const URGENCY_BADGE: Record<string, { cls: string; label: string }> = {
  critical: { cls: "b-red", label: "🔴 วิกฤต" },
  high: { cls: "b-orange", label: "🟠 สูง" },
  medium: { cls: "b-yellow", label: "🟡 กลาง" },
  low: { cls: "b-green", label: "🟢 ต่ำ" },
};

function sentimentLabel(s: string | null | undefined): string {
  return (s && SENTIMENT_LABEL[s]) || "—";
}

function urgencyBadge(u: string | null | undefined) {
  return (u && URGENCY_BADGE[u]) || { cls: "b-yellow", label: u ?? "—" };
}

/** เวลาแบบสั้นภาษาไทย (best-effort — เพี้ยน = —) */
function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("th-TH", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function OfficeCxPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-office" role={null} authed={false} title={TITLE} subtitle={SUBTITLE}>
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const db = await createClient();
  const viewer = await resolveEvalViewer(db);

  // ★ guard: default-deny — เข้าได้เฉพาะ admin/executive
  if (!viewer.role && !DEV_FALLBACK) redirect("/login?redirect=/chat-audit/office");
  if (!isAdminRole(viewer.role) || !viewer.tenantId) {
    return (
      <ChatAuditFrame active="chat-office" role={viewer.role} authed={!!viewer.role} title={TITLE} subtitle={SUBTITLE}>
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>หน้านี้เปิดเฉพาะผู้ดูแลระบบ / ผู้บริหาร</p>
          <p className="muted" style={{ fontSize: 13 }}>
            <Link href="/dashboard" className="underline">← กลับ Dashboard</Link>
          </p>
        </div>
      </ChatAuditFrame>
    );
  }

  // ช่วงเวลา
  const sp = await searchParams;
  const rangeKey = RANGE_OPTIONS.some((o) => o.key === sp.range) ? (sp.range as string) : DEFAULT_RANGE;
  const days = RANGE_OPTIONS.find((o) => o.key === rangeKey)?.days ?? 30;
  const sinceMs = days === null ? null : Date.now() - days * 24 * 60 * 60 * 1000;

  let d: OfficeDashboard;
  try {
    d = await getOfficeDashboard(db, viewer.tenantId, { sinceMs });
  } catch {
    return (
      <ChatAuditFrame active="chat-office" role={viewer.role} authed={!!viewer.role} title={TITLE} subtitle={SUBTITLE}>
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0040)</div>
      </ChatAuditFrame>
    );
  }

  const sTotal = d.sentiment.positive + d.sentiment.neutral + d.sentiment.negative;
  const pct = (n: number) => (sTotal > 0 ? Math.round((n / sTotal) * 100) : 0);
  const hasAnyData = d.conversationCount > 0 || d.analyzedCount > 0;

  return (
    <ChatAuditFrame active="chat-office" role={viewer.role} authed={!!viewer.role} title={TITLE} subtitle={SUBTITLE}>
      <div className="dash-views">
        {/* ตัวเลือกช่วงเวลา */}
        <nav className="risk-legend" aria-label="ช่วงเวลา">
          {RANGE_OPTIONS.map((o) => (
            <Link
              key={o.key}
              href={`/chat-audit/office?range=${o.key}`}
              className={`badge ${o.key === rangeKey ? "b-orange" : "b-green"}`}
              aria-current={o.key === rangeKey ? "page" : undefined}
            >
              {o.label}
            </Link>
          ))}
        </nav>

        {!hasAnyData ? (
          <section className="card">
            <p className="empty">ยังไม่มีข้อมูลแชท 1-1</p>
            <p className="muted" style={{ fontSize: 13, textAlign: "center" }}>
              เมื่อมีลูกค้าทักเข้ามาทางแชต 1-1 และระบบวิเคราะห์แล้ว ข้อมูลจะปรากฏที่นี่
            </p>
          </section>
        ) : (
          <>
            {/* 1) การ์ดสรุปบน */}
            <div className="kpi-grid">
              <div className="kpi">
                <div className="label">บทสนทนา 1-1</div>
                <div className="value">{d.conversationCount}</div>
                <div className="sample">ลูกค้าที่ทักเข้ามาโดยตรง</div>
              </div>
              <div className="kpi">
                <div className="label">ข้อความลูกค้าขาเข้า</div>
                <div className="value">{d.inboundMessageCount}</div>
                <div className="sample">รวมในช่วงที่เลือก</div>
              </div>
              <div className="kpi">
                <div className="label">ต้องดูด่วน</div>
                <div className={`value ${d.needsAttentionCount > 0 ? "v-orange" : "v-green"}`}>
                  {d.needsAttentionCount}
                </div>
                <div className="sample">ลูกค้าโมโห/เร่งด่วน</div>
              </div>
              <div className="kpi">
                <div className="label">ร้องเรียน</div>
                <div className={`value ${d.complaintCount > 0 ? "v-red" : "v-green"}`}>{d.complaintCount}</div>
                <div className="sample">บทสนทนาที่เป็นการตำหนิ</div>
              </div>
            </div>

            <div className="grid-2">
              {/* 2) สัดส่วนอารมณ์ลูกค้า */}
              <section className="card">
                <div className="section-title">
                  <span>สัดส่วนอารมณ์ลูกค้า</span>
                  <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{sTotal} บทสนทนา</span>
                </div>
                {sTotal === 0 ? (
                  <p className="empty">ยังไม่มีข้อมูลอารมณ์</p>
                ) : (
                  <>
                    <div className="bar-row">
                      <div className="name">😊 {SENTIMENT_LABEL.positive}</div>
                      <div className="bar-track"><div className="bar-fill good" style={{ width: `${pct(d.sentiment.positive)}%` }} /></div>
                      <div className="bar-val"><b>{d.sentiment.positive}</b> · {pct(d.sentiment.positive)}%</div>
                    </div>
                    <div className="bar-row">
                      <div className="name">😐 {SENTIMENT_LABEL.neutral}</div>
                      <div className="bar-track"><div className="bar-fill low" style={{ width: `${pct(d.sentiment.neutral)}%` }} /></div>
                      <div className="bar-val"><b>{d.sentiment.neutral}</b> · {pct(d.sentiment.neutral)}%</div>
                    </div>
                    <div className="bar-row">
                      <div className="name">😠 {SENTIMENT_LABEL.negative}</div>
                      <div className="bar-track"><div className="bar-fill bad" style={{ width: `${pct(d.sentiment.negative)}%` }} /></div>
                      <div className="bar-val"><b>{d.sentiment.negative}</b> · {pct(d.sentiment.negative)}%</div>
                    </div>
                  </>
                )}
              </section>

              {/* 3) หัวข้อที่ลูกค้าพูดถึงบ่อย */}
              <section className="card">
                <div className="section-title"><span>หัวข้อที่ลูกค้าพูดถึงบ่อย</span></div>
                {d.topTopics.length === 0 ? (
                  <p className="empty">ยังไม่มีข้อมูลหัวข้อ</p>
                ) : (
                  d.topTopics.map((t) => (
                    <div className="prob-row" key={t.topic}>
                      <span>{t.topic}</span>
                      <span className="cnt">{t.count}</span>
                    </div>
                  ))
                )}
              </section>
            </div>

            {/* 4) รายการต้องให้เจ้าหน้าที่ดูด่วน */}
            <section className="card">
              <div className="section-title">
                <span>ต้องให้เจ้าหน้าที่ดูด่วน</span>
                <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{d.attention.length} บทสนทนา</span>
              </div>
              {d.attention.length === 0 ? (
                <p className="empty">ไม่มีบทสนทนาที่ต้องดูด่วนในช่วงนี้</p>
              ) : (
                <div className="table-wrap">
                  <table className="dlv-table">
                    <thead>
                      <tr><th>ลูกค้า</th><th className="center">ความด่วน</th><th className="center">อารมณ์</th><th>สรุป</th><th>เวลา</th></tr>
                    </thead>
                    <tbody>
                      {d.attention.map((r) => {
                        const b = urgencyBadge(r.urgency);
                        return (
                          <tr key={r.id}>
                            <td>
                              <b style={{ color: "var(--navy-800)" }}>{r.customerLabel}</b>
                              {r.isComplaint ? <div style={{ fontSize: 10 }} className="muted">⚠ ร้องเรียน</div> : null}
                            </td>
                            <td className="center"><span className={`badge ${b.cls}`}>{b.label}</span></td>
                            <td className="center">{sentimentLabel(r.sentiment)}</td>
                            <td>{r.summary ?? "—"}</td>
                            <td>{fmtTime(r.at)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* 5) บทสนทนา 1-1 ล่าสุด */}
            <section className="card">
              <div className="section-title"><span>บทสนทนา 1-1 ล่าสุด</span></div>
              {d.recent.length === 0 ? (
                <p className="empty">ยังไม่มีบทสนทนา</p>
              ) : (
                <div className="table-wrap">
                  <table className="dlv-table">
                    <thead>
                      <tr><th>ลูกค้า</th><th className="center">อารมณ์</th><th className="center">ข้อความ</th><th>สรุป</th><th>เวลา</th></tr>
                    </thead>
                    <tbody>
                      {d.recent.map((r) => (
                        <tr key={r.id}>
                          <td><b style={{ color: "var(--navy-800)" }}>{r.customerLabel}</b></td>
                          <td className="center">{sentimentLabel(r.sentiment)}</td>
                          <td className="center">{r.messageCount}</td>
                          <td>{r.summary ?? "—"}</td>
                          <td>{fmtTime(r.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div className="note-box warn">
              🤖 อารมณ์/ความด่วน/หัวข้อ เป็นการประเมินของ AI จากข้อความลูกค้าขาเข้าในแชต 1-1 — <b>ไม่ใช่คำตัดสิน</b> ·
              หน้านี้ <b>ไม่เกี่ยวข้อง</b> กับการประเมินนักบัญชีรายคน (1-1 ระบบเห็นเฉพาะข้อความฝั่งลูกค้า)
            </div>
          </>
        )}
      </div>
    </ChatAuditFrame>
  );
}
