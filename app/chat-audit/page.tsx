import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { canSeeExecDashboard } from "@/lib/chat-dashboard/access";
import { getExecChatDashboard } from "@/lib/chat-dashboard/queries";
import ChatAuditFrame from "./_Frame";

export const dynamic = "force-dynamic";

const DEV_FALLBACK = process.env.NODE_ENV !== "production";

function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}`;
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

        <div className="kpi-grid">
          <div className="kpi"><div className="label">กลุ่มลูกค้า (LINE)</div><div className="value">{d.totalGroups}</div><div className="sample">กลุ่มที่ใช้งานอยู่</div></div>
          <div className="kpi"><div className="label">เคสเปิดอยู่</div><div className="value v-amber">{d.openCases}</div><div className="sample">ใหม่วันนี้ {d.newTodayCases}</div></div>
          <div className="kpi"><div className="label">เกิน SLA</div><div className={`value ${d.overdueCases > 0 ? "v-red" : "v-green"}`}>{d.overdueCases}</div><div className="sample">เคสที่เลยกำหนดตอบ/ปิด</div></div>
          <div className="kpi"><div className="label">เคสด่วน (critical/high)</div><div className="value v-orange">{d.urgentCases}</div><div className="sample">ต้องเร่งจัดการ</div></div>
        </div>
        <div className="kpi-grid">
          <div className="kpi"><div className="label">อัตราทวงซ้ำ</div><div className="value v-amber">{pct(d.repeatRate)}<span className="unit">%</span></div><div className="sample">ลูกค้าถาม/ขอเอกสารซ้ำ</div></div>
          <div className="kpi"><div className="label">เสี่ยงร้องเรียน</div><div className="value v-red">{d.complaints}</div><div className="sample">risk ส้ม+แดง (active)</div></div>
          <div className="kpi"><div className="label">ลูกค้าเสี่ยงยกเลิก</div><div className="value v-red">{d.cancelRisk}</div><div className="sample"><Link href="/chat-audit/risk" className="underline">ดูหน้าลูกค้าเสี่ยง →</Link></div></div>
          <div className="kpi"><div className="label">เคสทั้งหมด</div><div className="value">{Object.values(d.casesByStatus).reduce((a, b) => a + b, 0)}</div><div className="sample">รวมทุกสถานะ</div></div>
        </div>

        <div className="grid-2">
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

          <section className="card">
            <div className="section-title"><span>ปัญหาที่พบบ่อยสุด</span></div>
            {d.topProblems.length === 0 ? (
              <p className="empty">ยังไม่มีข้อมูลปัญหา</p>
            ) : (
              d.topProblems.map((p) => (
                <div className="prob-row" key={p.label}>
                  <span>{p.label}</span>
                  <span className="cnt">{p.count}</span>
                </div>
              ))
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
