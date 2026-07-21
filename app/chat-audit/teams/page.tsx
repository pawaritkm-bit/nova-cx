import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import {
  getTeamStructure,
  canSeeTeamStructure,
  type TeamNode,
  type CustomerType,
} from "@/lib/teams/queries";
import ChatAuditFrame from "../_Frame";

export const dynamic = "force-dynamic";

const DEV_FALLBACK = process.env.NODE_ENV !== "production";
const TITLE = "ตรวจแชต · โครงสร้างทีม";
const SUBTITLE =
  "ผังทีมบัญชีแบบอ่านง่าย — หัวหน้าทีม → นักบัญชีในทีม → ลูกค้าที่ดูแล (กดชื่อนักบัญชีเพื่อดูรายชื่อลูกค้า)";

/** ป้ายประเภทลูกค้าที่ทีมรับดูแล */
const TYPE_LABEL: Record<CustomerType, string> = {
  company: "บริษัท / นิติบุคคล",
  individual: "บุคคลธรรมดา",
};

/** class โทนสีการ์ดตามประเภททีม (บริษัท=accent, บุคคล=warning) */
function teamToneClass(type: CustomerType | null): string {
  if (type === "company") return "is-company";
  if (type === "individual") return "is-individual";
  return "is-unspecified";
}

export default async function TeamsPage() {
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-teams" role={null} authed={false} title={TITLE} subtitle={SUBTITLE}>
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const db = await createClient();
  const viewer = await resolveEvalViewer(db);

  // ★ guard: default-deny — เข้าได้เฉพาะ privileged (admin/executive/acc_lead) หรือ accountant
  if (!viewer.role && !DEV_FALLBACK) redirect("/login?redirect=/chat-audit/teams");
  if (!canSeeTeamStructure(viewer.role) || !viewer.tenantId) {
    return (
      <ChatAuditFrame active="chat-teams" role={viewer.role} authed={!!viewer.role} title={TITLE} subtitle={SUBTITLE}>
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>หน้านี้เปิดเฉพาะผู้บริหาร / หัวหน้าทีม / นักบัญชี</p>
          <p className="muted" style={{ fontSize: 13 }}>
            <Link href="/dashboard" className="underline">← กลับ Dashboard</Link>
          </p>
        </div>
      </ChatAuditFrame>
    );
  }

  let teams: TeamNode[];
  try {
    teams = await getTeamStructure(db, viewer.tenantId, viewer);
  } catch {
    return (
      <ChatAuditFrame active="chat-teams" role={viewer.role} authed={!!viewer.role} title={TITLE} subtitle={SUBTITLE}>
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ลองใหม่อีกครั้ง</div>
      </ChatAuditFrame>
    );
  }

  const isAccountant = viewer.role === "accountant";

  return (
    <ChatAuditFrame active="chat-teams" role={viewer.role} authed={!!viewer.role} title={TITLE} subtitle={SUBTITLE}>
      <div className="dash-views">
        {teams.length === 0 ? (
          <section className="card">
            <p className="empty">{isAccountant ? "คุณยังไม่ได้อยู่ในทีมใด" : "ยังไม่มีทีมในระบบ"}</p>
            <p className="muted" style={{ fontSize: 13, textAlign: "center" }}>
              {isAccountant
                ? "เมื่อผู้ดูแลระบบเพิ่มคุณเข้าทีม ผังทีมจะปรากฏที่นี่"
                : "เมื่อสร้างทีมและเพิ่มสมาชิกในหน้าจัดการข้อมูล ผังทีมจะปรากฏที่นี่"}
            </p>
          </section>
        ) : (
          <div className="team-grid">
            {teams.map((team) => (
              <section key={team.teamId} className={`card team-card ${teamToneClass(team.handlesCustomerType)}`}>
                {/* หัวการ์ด: ชื่อทีม + ประเภท + ลูกค้ารวม */}
                <div className="team-head">
                  <div>
                    <div className="team-name">{team.name}</div>
                    <span className="team-type-badge">
                      {team.handlesCustomerType ? TYPE_LABEL[team.handlesCustomerType] : "ไม่ระบุประเภท"}
                    </span>
                  </div>
                  <div className="team-total">
                    <span className="team-total-num">{team.totalCustomers}</span>
                    <span className="team-total-label">ลูกค้ารวม</span>
                  </div>
                </div>

                {/* รายชื่อสมาชิก (หัวหน้าอยู่บนสุด) */}
                {team.members.length === 0 ? (
                  <p className="empty" style={{ marginTop: 8 }}>ยังไม่มีสมาชิกในทีม</p>
                ) : (
                  <div className="team-members">
                    {team.members.map((m) => (
                      <details key={m.employeeId} className={`member-row${m.isLead ? " is-lead" : ""}`}>
                        <summary>
                          <span className="member-name">
                            {m.isLead ? <span className="crown" aria-hidden="true">👑</span> : null}
                            {m.name}
                            {m.isLead ? <span className="lead-tag">หัวหน้าทีม</span> : null}
                          </span>
                          <span className="member-count badge b-blue">{m.customerCount} ลูกค้า</span>
                        </summary>
                        {m.customers.length === 0 ? (
                          <p className="member-empty muted">ยังไม่มีลูกค้าที่ดูแล</p>
                        ) : (
                          <ul className="customer-list">
                            {m.customers.map((c, i) => (
                              <li key={`${m.employeeId}-${i}`}>
                                {c.code ? <span className="customer-code">{c.code}</span> : null}
                                <span className="customer-name">{c.name}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </details>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}

        <div className="note-box warn">
          👑 = หัวหน้าทีม · ตัวเลข &ldquo;ลูกค้า&rdquo; นับจากกลุ่มที่นักบัญชีดูแล (มีลูกค้าจับคู่แล้ว) ·
          {isAccountant ? " คุณเห็นเฉพาะทีมที่ตัวเองสังกัด" : " แสดงทุกทีมในสำนักงาน"}
        </div>
      </div>
    </ChatAuditFrame>
  );
}
