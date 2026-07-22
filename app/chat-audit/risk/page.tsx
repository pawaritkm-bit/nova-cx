import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { canSeeRiskDashboard, canAccessChatViewer } from "@/lib/chat-dashboard/access";
import { getRiskDashboard } from "@/lib/chat-dashboard/queries";
import { problemMeta, problemBadgeClass } from "@/lib/chat-dashboard/problem-labels";
import type { RiskRow } from "@/lib/chat-dashboard/types";
import ChatAuditFrame from "../_Frame";

export const dynamic = "force-dynamic";
const DEV_FALLBACK = process.env.NODE_ENV !== "production";

const LEVEL_BADGE: Record<string, { cls: string; label: string }> = {
  red: { cls: "b-red", label: "🔴 หัวหน้าเข้าด่วน" },
  orange: { cls: "b-orange", label: "🟠 เสี่ยงร้องเรียน" },
  yellow: { cls: "b-yellow", label: "🟡 ติดตาม" },
  green: { cls: "b-green", label: "🟢 ปกติ" },
};

/**
 * เซลล์ "สัญญาณ/สาเหตุ" — โชว์เหตุการณ์เจาะจง (ป้ายหมวด + detail จริงจาก AI)
 *   ลำดับ fallback: problems[] (มี type+detail) → summary → reason (กว้าง) → "—"
 */
function ReasonCell({ row }: { row: RiskRow }) {
  if (row.problems.length > 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {row.problems.slice(0, 3).map((p, i) => {
          const meta = problemMeta(p.type);
          return (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
              <span className={`badge ${problemBadgeClass(meta.tone)}`} style={{ flexShrink: 0 }}>
                {meta.label}
              </span>
              {p.detail ? <span style={{ fontSize: 13 }}>{p.detail}</span> : null}
            </div>
          );
        })}
      </div>
    );
  }
  const fallback = row.summary ?? row.reason;
  return <span style={{ fontSize: 13 }}>{fallback ?? "—"}</span>;
}

export default async function ChatRiskPage() {
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-risk" role={null} authed={false} title="ตรวจแชต · ลูกค้าเสี่ยง" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }

  const db = await createClient();
  const viewer = await resolveEvalViewer(db);

  if (!viewer.role && !DEV_FALLBACK) redirect("/login?redirect=/chat-audit/risk");
  if (!canSeeRiskDashboard(viewer.role)) {
    return (
      <ChatAuditFrame active="chat-risk" role={viewer.role} authed={!!viewer.role} title="ตรวจแชต · ลูกค้าเสี่ยง" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p>
          <p className="muted" style={{ fontSize: 13 }}><Link href="/dashboard" className="underline">← กลับ Dashboard</Link></p>
        </div>
      </ChatAuditFrame>
    );
  }

  // ★ L2: cs เปิด chat viewer ไม่ได้ → ไม่แสดงลิงก์ "เปิดเคส" (กัน dead link)
  const canOpenCase = canAccessChatViewer(viewer.role);
  let rows;
  try {
    rows = await getRiskDashboard(db, viewer);
  } catch {
    return (
      <ChatAuditFrame active="chat-risk" role={viewer.role} authed={!!viewer.role} title="ตรวจแชต · ลูกค้าเสี่ยง" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0035)</div>
      </ChatAuditFrame>
    );
  }

  return (
    <ChatAuditFrame
      active="chat-risk"
      role={viewer.role}
      authed={!!viewer.role}
      title="ตรวจแชต · ลูกค้าเสี่ยง"
      subtitle="ลูกค้าที่แสดงสัญญาณเสี่ยง: ถามซ้ำ · รอนาน · ไม่พอใจ · เสี่ยงยกเลิก — พร้อมสาเหตุและผู้รับผิดชอบ"
    >
      <div className="dash-views">
        <div className="risk-legend">
          <span className="badge b-green">🟢 ปกติ</span>
          <span className="badge b-yellow">🟡 ติดตาม</span>
          <span className="badge b-orange">🟠 เสี่ยงร้องเรียน</span>
          <span className="badge b-red">🔴 หัวหน้าเข้าด่วน</span>
        </div>

        <section className="card">
          <div className="section-title"><span>รายชื่อลูกค้าเสี่ยง (เรียงตามระดับ)</span><span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{rows.length} ราย</span></div>
          {rows.length === 0 ? (
            <p className="empty">ไม่มีลูกค้าเสี่ยงในขณะนี้</p>
          ) : (
            <div className="table-wrap">
              <table className="dlv-table">
                <thead>
                  <tr><th>ลูกค้า</th><th className="center">ระดับ</th><th>สัญญาณ / สาเหตุ</th><th>ผู้รับผิดชอบ</th><th className="center">เคส</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const b = LEVEL_BADGE[r.level] ?? LEVEL_BADGE.yellow;
                    return (
                      <tr key={r.alertId}>
                        {/* ★ pseudonymity: แสดงรหัสลูกค้า ไม่ใช่ชื่อจริง */}
                        <td><b style={{ color: "var(--navy-800)" }}>{r.customerLabel}</b></td>
                        <td className="center"><span className={`badge ${b.cls}`}>{b.label}</span>{r.escalated ? <div style={{ fontSize: 10 }} className="muted">↑ escalate แล้ว</div> : null}</td>
                        <td><ReasonCell row={r} /></td>
                        <td>{r.ownerName}</td>
                        <td className="center">{r.caseId && canOpenCase ? <Link href={`/chat-audit/cases/${r.caseId}`} className="underline">เปิด</Link> : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="note-box warn">
            <b>หมายเหตุ:</b> ระดับความเสี่ยงเป็นการประเมินของ AI จากพฤติกรรมในแชต (เวลาตอบ / การทวงซ้ำ / น้ำเสียง) — <b>ไม่ใช่คำตัดสิน</b> · แสดง <b>รหัสลูกค้า (ปลอมนาม)</b> ไม่ใช่ชื่อจริง
          </div>
        </section>
      </div>
    </ChatAuditFrame>
  );
}
