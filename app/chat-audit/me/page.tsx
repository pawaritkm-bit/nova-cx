import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { canSeeMeDashboard } from "@/lib/chat-dashboard/access";
import { getMeChatDashboard } from "@/lib/chat-dashboard/queries";
import { computeSlaStatus, formatSlaLabel } from "@/lib/dashboard/sla";
import ChatAuditFrame from "../_Frame";

export const dynamic = "force-dynamic";
const DEV_FALLBACK = process.env.NODE_ENV !== "production";

export default async function ChatMePage() {
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-me" role={null} authed={false} title="งานแชตของฉัน" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }

  const db = await createClient();
  const viewer = await resolveEvalViewer(db);

  if (!viewer.role && !DEV_FALLBACK) redirect("/login?redirect=/chat-audit/me");
  if (!canSeeMeDashboard(viewer.role)) {
    return (
      <ChatAuditFrame active="chat-me" role={viewer.role} authed={!!viewer.role} title="งานแชตของฉัน" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>หน้านี้เปิดเฉพาะนักบัญชี</p>
          <p className="muted" style={{ fontSize: 13 }}><Link href="/dashboard" className="underline">← กลับ Dashboard</Link></p>
        </div>
      </ChatAuditFrame>
    );
  }

  const now = Date.now();
  let d;
  try {
    d = await getMeChatDashboard(db, viewer, now);
  } catch {
    return (
      <ChatAuditFrame active="chat-me" role={viewer.role} authed={!!viewer.role} title="งานแชตของฉัน" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0035)</div>
      </ChatAuditFrame>
    );
  }

  const ev = d.latestEvaluation;

  return (
    <ChatAuditFrame
      active="chat-me"
      role={viewer.role}
      authed={!!viewer.role}
      title="งานแชตของฉัน"
      subtitle="งานที่ต้องจัดการวันนี้ · คะแนนและคำแนะนำเฉพาะคุณ (จากผลวิเคราะห์แชต)"
    >
      <div className="dash-views">
        <div className="kpi-grid">
          <div className="kpi"><div className="label">งานใหม่วันนี้</div><div className="value v-amber">{d.newToday}</div><div className="sample">เข้าวันนี้</div></div>
          <div className="kpi"><div className="label">ต้องตอบ</div><div className="value v-orange">{d.toRespond}</div><div className="sample">ยังไม่ได้ตอบครั้งแรก</div></div>
          <div className="kpi"><div className="label">ใกล้ครบ SLA</div><div className="value v-amber">{d.dueSoon}</div><div className="sample">เหลือ ≤ 2 ชม.</div></div>
          <div className="kpi"><div className="label">เกิน SLA</div><div className={`value ${d.overdue > 0 ? "v-red" : "v-green"}`}>{d.overdue}</div><div className="sample">{d.overdue === 0 ? "เยี่ยม! ไม่มีงานเกิน" : "รีบจัดการ"}</div></div>
        </div>

        <div className="grid-2">
          <section className="card">
            <div className="section-title"><span>งานที่ต้องจัดการ</span></div>
            {d.myCases.length === 0 ? (
              <p className="empty">ไม่มีงานค้าง 🎉</p>
            ) : (
              d.myCases.slice(0, 30).map((c) => {
                const sla = computeSlaStatus(c.resolution_due_at, now);
                return (
                  <div className="case-row" key={c.id}>
                    <div className="cdesc">
                      <b>{c.title ?? "เคส"}</b>
                      <small className="muted"> · {c.summary ?? "—"}</small>
                    </div>
                    <div className="case-badges">
                      {!c.first_responded_at ? <span className="badge b-orange">ต้องตอบ</span> : <span className="badge b-blue">กำลังทำ</span>}
                      <span className={`sla-badge sla-${sla.state}`}>{formatSlaLabel(sla)}</span>
                      <Link href={`/chat-audit/cases/${c.id}`} className="btn" style={{ padding: "3px 9px", fontSize: 11 }}>เปิด</Link>
                    </div>
                  </div>
                );
              })
            )}
          </section>

          <section className="card">
            <div className="section-title"><span>คะแนน & คำแนะนำส่วนตัว</span></div>
            {ev ? (
              <>
                <div className="score-hero" style={{ gap: 16 }}>
                  <div
                    className="score-ring"
                    style={{
                      background: `conic-gradient(var(--green) 0 ${ev.overall_score ?? 0}%, #e2e8f0 ${ev.overall_score ?? 0}% 100%)`,
                    }}
                  >
                    <div className="inner"><div className="num" style={{ color: "var(--green)" }}>{ev.overall_score !== null ? Math.round(ev.overall_score) : "—"}</div><div className="den">/100</div></div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="muted" style={{ fontSize: 12 }}>คะแนนล่าสุด · สถานะ: {ev.status}</div>
                    {ev.needs_review ? <span className="badge b-blue" style={{ marginTop: 6 }}>รอหัวหน้ายืนยัน</span> : null}
                  </div>
                </div>
              </>
            ) : (
              <p className="empty">ยังไม่มีผลประเมิน</p>
            )}

            {d.coaching ? (
              <>
                {d.coaching.strengths.length > 0 ? (
                  <div className="fb pos" style={{ marginTop: 10 }}><span className="fb-tag">✅ จุดเด่น</span><p>{d.coaching.strengths.slice(0, 3).join(" · ")}</p></div>
                ) : null}
                {d.coaching.improvements.length > 0 ? (
                  <div className="fb neg"><span className="fb-tag">💡 ควรปรับ</span><p>{d.coaching.improvements.slice(0, 3).join(" · ")}</p></div>
                ) : null}
              </>
            ) : null}
          </section>
        </div>

        {d.coaching && (d.coaching.exampleAnswers.length > 0 || d.coaching.checklist.length > 0) ? (
          <div className="grid-2">
            {d.coaching.exampleAnswers.length > 0 ? (
              <section className="card">
                <div className="section-title"><span>ตัวอย่างคำตอบที่ควรใช้</span></div>
                {d.coaching.exampleAnswers.slice(0, 4).map((ex, i) => (
                  <div className="fb better" key={i}><span className="fb-tag">💬 แนะนำ</span><p>{ex}</p></div>
                ))}
              </section>
            ) : null}
            {d.coaching.checklist.length > 0 ? (
              <section className="card">
                <div className="section-title"><span>Checklist</span></div>
                <ul className="checklist">
                  {d.coaching.checklist.slice(0, 8).map((item, i) => (
                    <li key={i}><span className="cbox" /><span>{item}</span></li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </ChatAuditFrame>
  );
}
