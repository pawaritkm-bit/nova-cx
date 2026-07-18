import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import { listCustomers, listTeams } from "@/lib/admin/service";
import { listChatGroups } from "@/lib/chat-admin/mapping";
import { rankCustomerSuggestions } from "@/lib/chat-admin/customer-suggest";
import { getActiveWeights } from "@/lib/chat-admin/weights";
import { listSlaRules } from "@/lib/chat-admin/sla";
import ChatAuditFrame from "../_Frame";
import AdminConfig from "./AdminConfig";
import "../chat-admin.css";
import "../../admin/admin.css";

export const dynamic = "force-dynamic";

/**
 * /chat-audit/admin — หน้าตั้งค่าโมดูลตรวจแชต (admin/executive เท่านั้น)
 *   แท็บ: จับคู่กลุ่ม→ลูกค้า · น้ำหนักคะแนน 8 มิติ · SLA rules
 * ★ guard admin/executive + tenant จาก session (ไม่เชื่อ client) — reuse resolveAdminContext
 *   decrypt ชื่อกลุ่มฝั่ง server เฉพาะ admin (listChatGroups)
 */
export default async function ChatAdminPage() {
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-admin" role={null} authed={false} title="ตั้งค่าตรวจแชต" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const ctx = await resolveAdminContext(authed);

  if (!ctx.hasSession) redirect("/login?redirect=/chat-audit/admin");
  if (!ctx.isAdmin || !ctx.tenantId) {
    return (
      <ChatAuditFrame active="chat-admin" role={ctx.role} authed={ctx.hasSession && !!ctx.role} title="ตั้งค่าตรวจแชต" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">
          <p style={{ fontWeight: 700, marginBottom: 4 }}>คุณไม่มีสิทธิ์เข้าถึงหน้าตั้งค่า</p>
          <p className="muted" style={{ fontSize: 13 }}>หน้านี้เปิดเฉพาะผู้ดูแลระบบ (admin) และผู้บริหาร (executive)</p>
          <p style={{ marginTop: 12 }}><Link href="/chat-audit" className="underline">← กลับ</Link></p>
        </div>
      </ChatAuditFrame>
    );
  }

  try {
    const service = createServiceRoleClient();
    const tenantId = ctx.tenantId;
    const [groups, customers, teams, weights, slaRules] = await Promise.all([
      listChatGroups(service, tenantId),
      listCustomers(service, tenantId),
      listTeams(service, tenantId),
      getActiveWeights(service, tenantId),
      listSlaRules(service, tenantId),
    ]);

    // ตัวช่วย 2: แนะนำลูกค้าจากชื่อกลุ่ม (คำนวณฝั่ง server จากชื่อที่ decrypt แล้ว — ไม่ query เพิ่ม)
    const matchable = customers.map((c) => ({ id: c.id, name: c.name, business_name: c.business_name }));
    const suggestionsByGroup: Record<string, { customerId: string; customerName: string }[]> = {};
    for (const g of groups) {
      if (g.customerId) continue; // จับคู่แล้ว ไม่ต้องแนะนำ
      const ranked = rankCustomerSuggestions(g.groupName, matchable, 3);
      if (ranked.length > 0) {
        suggestionsByGroup[g.id] = ranked.map((s) => ({ customerId: s.customerId, customerName: s.customerName }));
      }
    }

    return (
      <ChatAuditFrame
        active="chat-admin"
        role={ctx.role}
        authed
        title="ตั้งค่าตรวจแชต"
        subtitle="จับคู่กลุ่ม LINE→ลูกค้า · น้ำหนักคะแนน 8 มิติ · เงื่อนไข SLA"
      >
        <AdminConfig
          groups={groups}
          customers={customers.map((c) => ({ id: c.id, name: c.name, code: c.customer_code }))}
          teams={teams.map((t) => ({ id: t.id, name: t.name }))}
          weights={weights}
          slaRules={slaRules}
          suggestionsByGroup={suggestionsByGroup}
        />
      </ChatAuditFrame>
    );
  } catch {
    return (
      <ChatAuditFrame active="chat-admin" role={ctx.role} authed title="ตั้งค่าตรวจแชต" subtitle="โมดูล AI วิเคราะห์แชท">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่าตั้งค่า SUPABASE_SERVICE_ROLE_KEY และ apply migration ครบ (ถึง 0035)</div>
      </ChatAuditFrame>
    );
  }
}
