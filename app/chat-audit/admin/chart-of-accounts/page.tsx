import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAdminContext } from "@/lib/admin/guard";
import {
  listChartOfAccountsAdmin,
  PROTECTED_CODES,
  BANK_STRUCTURAL_CODES,
} from "@/lib/accounting/chart-accounts-data";
import ChatAuditFrame from "../../_Frame";
import ChartOfAccountsPanel from "./ChartOfAccountsPanel";
import "../../chat-admin.css";
import "../../../admin/admin.css";

export const dynamic = "force-dynamic";

/**
 * /chat-audit/admin/chart-of-accounts — จัดการผังบัญชี (เฟส 1 ส่วน A9, docs/06 หมวด A)
 *   list + เพิ่ม/แก้ชื่อ-หมวด-เงินฝาก/เปิดปิดใช้งาน/soft-delete — tenant-scoped
 * ★ guard admin/executive + tenant จาก session (ไม่เชื่อ client) — reuse resolveAdminContext
 *   (ผังบัญชีเป็น tenant-level ไม่ผูกลูกค้า → เฉพาะ admin/executive ตาม docs/06 หมวด 0.9)
 */
export default async function ChartOfAccountsAdminPage() {
  if (!getSupabaseEnv()) {
    return (
      <ChatAuditFrame active="chat-admin" role={null} authed={false} title="ผังบัญชี" subtitle="จัดการผังบัญชีกลาง">
        <div className="card">ยังไม่ได้ตั้งค่าฐานข้อมูล</div>
      </ChatAuditFrame>
    );
  }

  const authed = await createClient();
  const ctx = await resolveAdminContext(authed);
  if (!ctx.hasSession) redirect("/login?redirect=/chat-audit/admin/chart-of-accounts");
  if (!ctx.isAdmin || !ctx.tenantId) {
    return (
      <ChatAuditFrame active="chat-admin" role={ctx.role} authed={ctx.hasSession && !!ctx.role} title="ผังบัญชี" subtitle="จัดการผังบัญชีกลาง">
        <div className="card"><p style={{ fontWeight: 700 }}>คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p></div>
      </ChatAuditFrame>
    );
  }

  try {
    const service = createServiceRoleClient();
    const accounts = await listChartOfAccountsAdmin(service, ctx.tenantId);

    return (
      <ChatAuditFrame
        active="chat-admin"
        role={ctx.role}
        authed
        title="ผังบัญชี"
        subtitle="จัดการผังบัญชีกลาง (ใช้ร่วมทุกลูกค้าในสำนักงานของคุณ)"
      >
        <div className="dash-views">
          <p><Link href="/chat-audit/admin" className="underline">← กลับหน้าตั้งค่า</Link></p>
          <ChartOfAccountsPanel
            accounts={accounts}
            protectedCodes={[...PROTECTED_CODES]}
            bankStructuralCodes={[...BANK_STRUCTURAL_CODES]}
          />
        </div>
      </ChatAuditFrame>
    );
  } catch {
    return (
      <ChatAuditFrame active="chat-admin" role={ctx.role} authed title="ผังบัญชี" subtitle="จัดการผังบัญชีกลาง">
        <div className="card">อ่านข้อมูลไม่สำเร็จ — ตรวจว่า apply migration ครบ (ถึง 0063)</div>
      </ChatAuditFrame>
    );
  }
}
