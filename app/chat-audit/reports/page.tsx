import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveEvalViewer } from "@/lib/evaluation/context";
import { canSeeAccountantReport } from "@/lib/reports/report-access";
import { resolveReportAccess, isValidPeriod } from "@/lib/reports/accountant-report";
import { listEmployees } from "@/lib/admin/service";
import ChatAuditFrame from "../_Frame";
import "../chat-admin.css";

export const dynamic = "force-dynamic";
const DEV_FALLBACK = process.env.NODE_ENV !== "production";

/** เดือนปัจจุบันรูป YYYY-MM (UTC) */
function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * /chat-audit/reports — เลือกพนักงาน + รอบเดือน เพื่อดูรายงานประเมิน
 *   ★ guard tier: exec/admin/auditor=ทั้งหมด · acc_lead=ทีมตน · hr=confirmed · accountant=ตัวเอง
 *     (scope รายชื่อพนักงานที่เห็นได้บังคับด้วย resolveReportAccess ต่อคน)
 */
export default async function ReportsListPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const sp = await searchParams;
  const period = sp.period && isValidPeriod(sp.period) ? sp.period : currentPeriod();

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-report" role={null} authed={false} title="รายงานประเมินนักบัญชี" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }

  const db = await createClient();
  const viewer = await resolveEvalViewer(db);
  if (!viewer.role && !DEV_FALLBACK) redirect("/login?redirect=/chat-audit/reports");
  if (!canSeeAccountantReport(viewer.role) || !viewer.tenantId) {
    return (
      <ChatAuditFrame active="chat-report" role={viewer.role} authed={!!viewer.role} title="รายงานประเมินนักบัญชี" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card"><p style={{ fontWeight: 700 }}>คุณไม่มีสิทธิ์ดูรายงานนี้</p><p className="muted" style={{ fontSize: 13, marginTop: 8 }}><Link href="/dashboard" className="underline">← กลับ Dashboard</Link></p></div>
      </ChatAuditFrame>
    );
  }

  // accountant → เข้าดูรายงานของตัวเองได้ทันที (ไม่ต้องเลือกคน)
  if (viewer.role === "accountant") {
    if (viewer.employeeId) {
      redirect(`/chat-audit/reports/${viewer.employeeId}?period=${period}`);
    }
    return (
      <ChatAuditFrame active="chat-report" role={viewer.role} authed title="รายงานประเมินนักบัญชี" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">บัญชีของคุณยังไม่ได้ผูกกับข้อมูลพนักงาน — ติดต่อผู้ดูแลระบบ</div>
      </ChatAuditFrame>
    );
  }

  let people: { id: string; name: string }[] = [];
  try {
    const service = createServiceRoleClient();
    const employees = await listEmployees(service, viewer.tenantId);
    people = employees
      .filter((e) => e.is_active)
      .filter((e) => resolveReportAccess(viewer, e.id).allowed) // ★ scope ต่อคน (default deny)
      .map((e) => ({ id: e.id, name: e.nickname || e.first_name }));
  } catch {
    return (
      <ChatAuditFrame active="chat-report" role={viewer.role} authed title="รายงานประเมินนักบัญชี" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0035)</div>
      </ChatAuditFrame>
    );
  }

  return (
    <ChatAuditFrame
      active="chat-report"
      role={viewer.role}
      authed
      title="รายงานประเมินนักบัญชี (รายเดือน)"
      subtitle="เลือกพนักงานและรอบเดือน เพื่อดูรายงานสำหรับหัวหน้าอนุมัติ + Export"
    >
      <div className="dash-views">
        <div className="card">
          <form method="get" className="inline-form" style={{ marginBottom: 4 }}>
            <label style={{ fontWeight: 600, fontSize: 14 }}>รอบเดือน:</label>
            <input type="month" name="period" defaultValue={period} />
            <button type="submit" className="btn">ดูรอบนี้</button>
          </form>
          {viewer.role === "hr" ? (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              🔒 ฝ่ายบุคคลเห็นเฉพาะคะแนนที่หัวหน้ายืนยันแล้ว (ไม่เห็นหลักฐานแชตดิบ)
            </p>
          ) : null}
        </div>

        <div className="card">
          <div className="section-title"><span>พนักงานที่ดูรายงานได้</span></div>
          {people.length === 0 ? (
            <p className="empty">ไม่มีพนักงานในขอบเขตสิทธิ์ของคุณ</p>
          ) : (
            <div className="table-wrap">
              <table className="admin-table">
                <thead><tr><th>พนักงาน</th><th className="center"></th></tr></thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td className="center">
                        <Link href={`/chat-audit/reports/${p.id}?period=${period}`} className="btn">ดูรายงาน</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </ChatAuditFrame>
  );
}
