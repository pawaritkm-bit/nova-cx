import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { canSeeExecDashboard } from "@/lib/chat-dashboard/access";
import { getExecChatDashboard } from "@/lib/chat-dashboard/queries";
import { problemMeta, problemBadgeClass } from "@/lib/chat-dashboard/problem-labels";
import ChatAuditFrame from "./_Frame";

export const dynamic = "force-dynamic";

const DEV_FALLBACK = process.env.NODE_ENV !== "production";

function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}`;
}

/** สีแท่ง "สุขภาพการดูแล": ≥90% เขียว · ≥70% เหลือง · <70% แดง */
function healthBarClass(rate: number | null): string {
  if (rate === null) return "";
  if (rate >= 0.9) return "good";
  if (rate >= 0.7) return "low";
  return "bad";
}

export default async function ChatExecPage() {
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-exec" role={null} authed={false} title="ตรวจแชต · ภาพรวมผู้บริหาร" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const db = await createClient();
  const viewer = await resolveEvalViewer(db);

  // ★ guard ก่อน fetch (default-deny)
  if (!viewer.role && !DEV_FALLBACK) redirect("/login?redirect=/chat-audit");
  if (!canSeeExecDashboard(viewer.role)) {
    return (
      <ChatAuditFrame active="chat-exec" role={viewer.role} authed={!!viewer.role} title="ตรวจแชต · ภาพรวมผู้บริหาร" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>หน้านี้เปิดเฉพาะผู้บริหาร / ผู้ดูแลระบบ / ผู้ตรวจสอบ</p>
          <p className="muted" style={{ fontSize: 13 }}>
            <Link href="/dashboard" className="underline">← กลับ Dashboard</Link>
          </p>
        </div>
      </ChatAuditFrame>
    );
  }

  const now = Date.now();
  let d;
  try {
    d = await getExecChatDashboard(db, now);
  } catch {
    return (
      <ChatAuditFrame active="chat-exec" role={viewer.role} authed={!!viewer.role} title="ตรวจแชต · ภาพรวมผู้บริหาร" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0035)</div>
      </ChatAuditFrame>
    );
  }

  return (
    <ChatAuditFrame
      active="chat-exec"
      role={viewer.role}
      authed={!!viewer.role}
      title="ตรวจแชต · ภาพรวมผู้บริหาร"
      subtitle="ภาพรวมสุขภาพงานบริการลูกค้าและความเสี่ยง — วิเคราะห์จากแชตกลุ่ม LINE"
    >
      <div className="dash-views">
        <div className="risk-legend">
          <span className="badge b-green">🟢 ปกติ</span>
          <span className="badge b-yellow">🟡 ติดตาม</span>
          <span className="badge b-orange">🟠 เสี่ยงร้องเรียน</span>
          <span className="badge b-red">🔴 หัวหน้าเข้าด่วน</span>
        </div>

        {/* ★ แถว KPI หลัก (ตาม demo): รอตอบ · ลูกค้าเสี่ยง · เกิน SLA · AI รอตรวจ */}
        <div className="kpi-grid">
          <div className="kpi"><div className="label">เรื่องรอตอบ</div><div className={`value ${d.waitingCases > 0 ? "v-amber" : "v-green"}`}>{d.waitingCases}</div><div className="sample">เคสเปิดที่ยังไม่ตอบครั้งแรก</div></div>
          <div className="kpi"><div className="label">ลูกค้าเสี่ยง</div><div className={`value ${d.activeRisk > 0 ? "v-red" : "v-green"}`}>{d.activeRisk}</div><div className="sample"><Link href="/chat-audit/risk" className="underline">ดูลูกค้าเสี่ยง →</Link></div></div>
          <div className="kpi"><div className="label">เกิน SLA</div><div className={`value ${d.overdueCases > 0 ? "v-red" : "v-green"}`}>{d.overdueCases}</div><div className="sample">เคสที่เลยกำหนดตอบ/ปิด</div></div>
          <div className="kpi"><div className="label">AI รอหัวหน้าตรวจ</div><div className={`value ${d.aiPendingReview > 0 ? "v-amber" : "v-green"}`}>{d.aiPendingReview}</div><div className="sample">ผลวิเคราะห์ที่ AI ไม่มั่นใจ</div></div>
        </div>
        {/* แถว KPI เสริม (บริบทเดิมที่ยังใช้ได้) */}
        <div className="kpi-grid">
          <div className="kpi"><div className="label">กลุ่มลูกค้า (LINE)</div><div className="value">{d.totalGroups}</div><div className="sample">กลุ่มที่ใช้งานอยู่</div></div>
          <div className="kpi"><div className="label">เคสเปิดอยู่</div><div className="value v-amber">{d.openCases}</div><div className="sample">ใหม่วันนี้ {d.newTodayCases}</div></div>
          <div className="kpi"><div className="label">อัตราทวงซ้ำ</div><div className="value v-amber">{pct(d.repeatRate)}<span className="unit">%</span></div><div className="sample">ลูกค้าถาม/ขอเอกสารซ้ำ</div></div>
          <div className="kpi"><div className="label">เสี่ยงร้องเรียน</div><div className="value v-red">{d.complaints}</div><div className="sample">risk ส้ม+แดง (active)</div></div>
        </div>

        {/* ★ เหตุการณ์เร่งด่วน — เรียงตามความด่วน + เหตุการณ์เจาะจง (ป้ายหมวด + detail จริง) */}
        <section className="card">
          <div className="section-title"><span>เหตุการณ์เร่งด่วน</span><span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>เรียงตามความด่วน (เกิน SLA / ระดับเคส)</span></div>
          {d.incidents.length === 0 ? (
            <p className="empty">ยังไม่พบเหตุการณ์ที่ต้องจัดการ</p>
          ) : (
            <div className="table-wrap">
              <table className="dlv-table">
                <thead>
                  <tr><th>ลูกค้า</th><th>เหตุการณ์</th><th>ผู้รับผิดชอบ</th><th className="center">SLA</th></tr>
                </thead>
                <tbody>
                  {d.incidents.map((inc) => {
                    const meta = problemMeta(inc.problemType);
                    return (
                      <tr key={inc.caseId}>
                        <td><b style={{ color: "var(--navy-800)" }}>{inc.customerLabel}</b></td>
                        <td>
                          <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                            <span className={`badge ${problemBadgeClass(meta.tone)}`} style={{ flexShrink: 0 }}>{meta.label}</span>
                            <span style={{ fontSize: 13 }}>{inc.detail}</span>
                          </div>
                        </td>
                        <td>{inc.ownerName}</td>
                        <td className="center">
                          {inc.overdue
                            ? <span className="badge b-red">เกิน SLA</span>
                            : <Link href={`/chat-audit/cases/${inc.caseId}`} className="underline">เปิด</Link>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="grid-2">
          {/* ★ สุขภาพการดูแล 7 วัน — อัตราตอบภายใน SLA รายวัน (CSS bar ล้วน) */}
          <section className="card">
            <div className="section-title"><span>สุขภาพการดูแล 7 วัน</span><span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>อัตราตอบภายใน SLA</span></div>
            {d.careHealth.every((h) => h.total === 0) ? (
              <p className="empty">ยังไม่มีข้อมูลการตอบใน 7 วันนี้</p>
            ) : (
              d.careHealth.map((h) => (
                <div className="bar-row" key={h.date}>
                  <div className="name">{h.label}</div>
                  <div className="bar-track">
                    {h.rate !== null ? (
                      <div className={`bar-fill ${healthBarClass(h.rate)}`} style={{ width: `${Math.round(h.rate * 100)}%` }} />
                    ) : null}
                  </div>
                  <div className="bar-val">{h.rate !== null ? <><b>{Math.round(h.rate * 100)}%</b> <span className="muted">({h.withinSla}/{h.total})</span></> : <span className="muted">—</span>}</div>
                </div>
              ))
            )}
          </section>

          <section className="card">
            <div className="section-title"><span>ทีมงานที่มีงานค้างสูง</span><span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>งานค้าง = เคสเปิดที่ยังไม่ปิด</span></div>
            {d.ownerBacklog.length === 0 ? (
              <p className="empty">ยังไม่มีงานค้าง</p>
            ) : (
              d.ownerBacklog.map((o) => {
                const max = d.ownerBacklog[0].open || 1;
                return (
                  <div className="bar-row" key={o.employeeId}>
                    <div className="name">{o.name}</div>
                    <div className="bar-track"><div className={`bar-fill${o.overdue > 0 ? " bad" : o.open >= max * 0.6 ? " low" : ""}`} style={{ width: `${Math.round((o.open / max) * 100)}%` }} /></div>
                    <div className="bar-val"><b>{o.open}</b> เคส{o.overdue > 0 ? ` · เกิน ${o.overdue}` : ""}</div>
                  </div>
                );
              })
            )}
          </section>
        </div>

        <div className="note-box warn">
          🤖 ตัวเลขความเสี่ยง/ปัญหาเป็นการประเมินของ AI จากพฤติกรรมในแชต — <b>ไม่ใช่คำตัดสิน</b> หัวหน้าควรตรวจบริบทจริงก่อนดำเนินการ
        </div>
      </div>
    </ChatAuditFrame>
  );
}
