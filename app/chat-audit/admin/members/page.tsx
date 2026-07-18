import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import { listEmployees } from "@/lib/admin/service";
import { listMemberDirectory } from "@/lib/chat-admin/member-directory";
import ChatAuditFrame from "../../_Frame";
import MemberDirectory from "./MemberDirectory";
import "../../chat-admin.css";
import "../../../admin/admin.css";

export const dynamic = "force-dynamic";

/**
 * /chat-audit/admin/members — "จับคู่สมาชิก (ภาพรวม)" ระดับ tenant (ตัวช่วย 1)
 *   list distinct line_user_id ข้ามทุกกลุ่ม + group count → ผูกตัวตนทีเดียวหลายกลุ่ม (review-first)
 * ★ guard admin/executive + tenant จาก session (ไม่เชื่อ client) · decrypt ชื่อฝั่ง server
 */
export default async function ChatMembersOverviewPage() {
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-admin" role={null} authed={false} title="จับคู่สมาชิก (ภาพรวม)" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const ctx = await resolveAdminContext(authed);
  if (!ctx.hasSession) redirect("/login?redirect=/chat-audit/admin/members");
  if (!ctx.isAdmin || !ctx.tenantId) {
    return (
      <ChatAuditFrame active="chat-admin" role={ctx.role} authed={ctx.hasSession && !!ctx.role} title="จับคู่สมาชิก (ภาพรวม)" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card"><p style={{ fontWeight: 700 }}>คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p></div>
      </ChatAuditFrame>
    );
  }

  try {
    const service = createServiceRoleClient();
    const tenantId = ctx.tenantId;
    const [entries, employees] = await Promise.all([
      listMemberDirectory(service, tenantId),
      listEmployees(service, tenantId),
    ]);

    // เฉพาะพนักงานบัญชี (ผูกกับสมาชิกที่เป็นนักบัญชี/หัวหน้า)
    const accountants = employees
      .filter((e) => e.is_active && (e.employee_type === "accountant" || e.employee_type === "other"))
      .map((e) => ({ id: e.id, name: e.nickname || e.first_name }));

    return (
      <ChatAuditFrame
        active="chat-admin"
        role={ctx.role}
        authed
        title="จับคู่สมาชิก (ภาพรวม)"
        subtitle="ผูกตัวตนนักบัญชีทีเดียวหลายกลุ่ม (ตรวจก่อนผูก)"
      >
        <div className="dash-views">
          <p><Link href="/chat-audit/admin" className="underline">← กลับหน้าตั้งค่า</Link></p>
          <MemberDirectory entries={entries} employees={accountants} />
        </div>
      </ChatAuditFrame>
    );
  } catch {
    return (
      <ChatAuditFrame active="chat-admin" role={ctx.role} authed title="จับคู่สมาชิก (ภาพรวม)" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0035)</div>
      </ChatAuditFrame>
    );
  }
}
