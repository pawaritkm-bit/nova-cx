import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import { listEmployees } from "@/lib/admin/service";
import { listChatGroups, listChatMembers } from "@/lib/chat-admin/mapping";
import ChatAuditFrame from "../../../_Frame";
import MembersPanel from "./MembersPanel";
import "../../../chat-admin.css";
import "../../../../admin/admin.css";

export const dynamic = "force-dynamic";

/**
 * /chat-audit/admin/groups/[id] — จับคู่สมาชิกในกลุ่ม → พนักงาน / ระบุบทบาท
 *   ★ guard admin/executive + tenant จาก session · decrypt ชื่อสมาชิกฝั่ง server
 */
export default async function GroupMembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-admin" role={null} authed={false} title="จับคู่สมาชิก" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const ctx = await resolveAdminContext(authed);
  if (!ctx.hasSession) redirect(`/login?redirect=/chat-audit/admin/groups/${id}`);
  if (!ctx.isAdmin || !ctx.tenantId) {
    return (
      <ChatAuditFrame active="chat-admin" role={ctx.role} authed={ctx.hasSession && !!ctx.role} title="จับคู่สมาชิก" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card"><p style={{ fontWeight: 700 }}>คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p></div>
      </ChatAuditFrame>
    );
  }

  try {
    const service = createServiceRoleClient();
    const tenantId = ctx.tenantId;
    const [groups, members, employees] = await Promise.all([
      listChatGroups(service, tenantId),
      listChatMembers(service, tenantId, id),
      listEmployees(service, tenantId),
    ]);
    const group = groups.find((g) => g.id === id);
    if (!group) {
      return (
        <ChatAuditFrame active="chat-admin" role={ctx.role} authed title="จับคู่สมาชิก" subtitle="โมดูล AI วิเคราะห์แชท">
          <div className="card"><p style={{ fontWeight: 700 }}>ไม่พบกลุ่มนี้ (หรืออยู่นอกสำนักงานของคุณ)</p><p style={{ marginTop: 10 }}><Link href="/chat-audit/admin" className="underline">← กลับหน้าตั้งค่า</Link></p></div>
        </ChatAuditFrame>
      );
    }

    // เฉพาะพนักงานบัญชี (ผูกกับสมาชิกที่เป็นนักบัญชี/หัวหน้า)
    const accountants = employees
      .filter((e) => e.is_active && (e.employee_type === "accountant" || e.employee_type === "other"))
      .map((e) => ({ id: e.id, name: e.nickname || e.first_name }));

    return (
      <ChatAuditFrame
        active="chat-admin"
        role={ctx.role}
        authed
        title="จับคู่สมาชิกในกลุ่ม"
        subtitle={group.groupName ? `กลุ่ม: ${group.groupName}` : "กลุ่ม LINE (ไม่มีชื่อ)"}
      >
        <div className="dash-views">
          <p><Link href="/chat-audit/admin" className="underline">← กลับหน้าตั้งค่า</Link></p>
          <MembersPanel members={members} employees={accountants} />
        </div>
      </ChatAuditFrame>
    );
  } catch {
    return (
      <ChatAuditFrame active="chat-admin" role={ctx.role} authed title="จับคู่สมาชิก" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0035)</div>
      </ChatAuditFrame>
    );
  }
}
