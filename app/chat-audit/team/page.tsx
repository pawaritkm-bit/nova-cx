import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { canSeeTeamDashboard } from "@/lib/chat-dashboard/access";
import { getTeamChatDashboard } from "@/lib/chat-dashboard/queries";
import ChatAuditFrame from "../_Frame";

export const dynamic = "force-dynamic";
const DEV_FALLBACK = process.env.NODE_ENV !== "production";

export default async function ChatTeamPage() {
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-team" role={null} authed={false} title="ตรวจแชต · หัวหน้าทีม" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }

  const db = await createClient();
  const viewer = await resolveEvalViewer(db);

  if (!viewer.role && !DEV_FALLBACK) redirect("/login?redirect=/chat-audit/team");
  if (!canSeeTeamDashboard(viewer.role)) {
    return (
      <ChatAuditFrame active="chat-team" role={viewer.role} authed={!!viewer.role} title="ตรวจแชต · หัวหน้าทีม" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>หน้านี้เปิดเฉพาะหัวหน้าทีมบัญชี</p>
          <p className="muted" style={{ fontSize: 13 }}><Link href="/dashboard" className="underline">← กลับ Dashboard</Link></p>
        </div>
      </ChatAuditFrame>
    );
  }

  const now = Date.now();
  let d;
  try {
    d = await getTeamChatDashboard(db, viewer, now);
  } catch {
    return (
      <ChatAuditFrame active="chat-team" role={viewer.role} authed={!!viewer.role} title="ตรวจแชต · หัวหน้าทีม" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0035)</div>
      </ChatAuditFrame>
    );
  }

  const maxOpen = Math.max(1, ...d.members.map((m) => m.openCases));

  return (
    <ChatAuditFrame
      active="chat-team"
      role={viewer.role}
      authed={!!viewer.role}
      title="ตรวจแชต · หัวหน้าทีม"
      subtitle="ผลงานนักบัญชีในทีม · งานค้าง/เกิน · เคสที่ต้องตรวจ · คำตอบที่ AI มองว่าอาจผิด"
    >
      <div className="dash-views">
        <div className="kpi-grid">
          <div className="kpi"><div className="label">นักบัญชีในทีม</div><div className="value">{d.members.length}</div><div className="sample">คน</div></div>
          <div className="kpi"><div className="label">เคสต้องตรวจ</div><div className="value v-amber">{d.toReviewCount}</div><div className="sample">รอหัวหน้ายืนยันคะแนน</div></div>
          <div className="kpi"><div className="label">AI สงสัยอาจผิด</div><div className="value v-orange">{d.needsExpertTotal}</div><div className="sample">ควรตรวจก่อนแจ้งลูกค้า</div></div>
          <div className="kpi"><div className="label">งานเกิน SLA ในทีม</div><div className={`value ${d.overdueTotal > 0 ? "v-red" : "v-green"}`}>{d.overdueTotal}</div><div className="sample">งานค้างรวม {d.openTotal}</div></div>
        </div>

        <div className="grid-2">
          <section className="card">
            <div className="section-title"><span>คะแนนนักบัญชี (เฉลี่ย)</span><span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>n = จำนวนใบประเมิน</span></div>
            {d.members.length === 0 ? (
              <p className="empty">ยังไม่มีสมาชิกในทีม</p>
            ) : (
              d.members.map((m) => (
                <div className="bar-row" key={m.employeeId}>
                  <div className="name">{m.name}</div>
                  <div className="bar-track"><div className={`bar-fill${m.avgScore !== null && m.avgScore < 70 ? " low" : ""}`} style={{ width: `${m.avgScore ?? 0}%` }} /></div>
                  <div className="bar-val"><b>{m.avgScore ?? "—"}</b> <span className="muted">(n={m.n})</span></div>
                </div>
              ))
            )}
          </section>

          <section className="card">
            <div className="section-title"><span>เวลาตอบ & งานค้าง รายคน</span></div>
            <div className="table-wrap">
              <table className="dlv-table">
                <thead><tr><th>นักบัญชี</th><th className="center">งานค้าง</th><th className="center">เกิน SLA</th><th className="center">AI อาจผิด</th></tr></thead>
                <tbody>
                  {d.members.map((m) => (
                    <tr key={m.employeeId}>
                      <td>{m.name}</td>
                      <td className="center">{m.openCases}</td>
                      <td className="center">{m.overdueCases > 0 ? <span className="badge b-red">{m.overdueCases}</span> : <span className="badge b-green">0</span>}</td>
                      <td className="center">{m.needsExpertReview > 0 ? <span className="badge b-orange">{m.needsExpertReview}</span> : "0"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>* งานค้างสูงสุดในทีม = {maxOpen}</p>
          </section>
        </div>

        <section className="card">
          <div className="section-title"><span>เคสที่ต้องตรวจ / รอยืนยันคะแนน</span></div>
          {d.reviewQueue.length === 0 ? (
            <p className="empty">ไม่มีเคสที่รอตรวจ</p>
          ) : (
            d.reviewQueue.map((r) => (
              <div className="case-row" key={r.evaluationId}>
                <div className="cid">{r.overall !== null ? `${Math.round(r.overall)}/100` : "—"}</div>
                <div className="cdesc">{r.ownerName}<small className="muted"> · สถานะ: {r.status}</small></div>
                <div className="case-badges">
                  <span className="badge b-blue">รอยืนยัน</span>
                  <Link href={`/chat-audit/evaluations/${r.evaluationId}`} className="btn" style={{ padding: "4px 10px", fontSize: 12 }}>ประเมิน</Link>
                </div>
              </div>
            ))
          )}
        </section>

        <div className="note-box warn">🤖 คะแนนเป็นข้อเสนอของ AI พร้อมหลักฐาน — หัวหน้าต้องยืนยันก่อนเสมอ (AI ไม่ลงโทษอัตโนมัติ)</div>
      </div>
    </ChatAuditFrame>
  );
}
