import type { SupabaseClient } from "@supabase/supabase-js";
import { isRoleCode } from "@/lib/dashboard/types";
import type { Viewer } from "./access";

/**
 * resolve viewer context สำหรับ tier guard (Phase 4)
 *   - อ่าน role/employee ของผู้ใช้จาก session (users ตาม auth.uid()) — ห้ามเชื่อค่า client
 *   - ถ้าเป็น acc_lead → resolve รายชื่อพนักงานในทีมที่ตนเป็นหัวหน้า (teamMemberIds)
 *   ใช้ cookie client (authenticated) เพื่อให้ auth.uid()/RLS ทำงานตามผู้ล็อกอินจริง
 */
export async function resolveEvalViewer(db: SupabaseClient): Promise<Viewer> {
  const deny: Viewer = { role: null, employeeId: null, tenantId: null, teamMemberIds: new Set() };

  try {
    const { data: auth } = await db.auth.getUser();
    if (!auth?.user) return deny;

    const { data: row } = await db
      .from("users")
      .select("employee_id, tenant_id, roles(code)")
      .eq("auth_user_id", auth.user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!row) return deny;

    const r = row as { employee_id?: string | null; tenant_id?: string | null; roles?: unknown };
    const rel = r.roles;
    const code =
      Array.isArray(rel) && rel.length > 0
        ? (rel[0] as { code?: string }).code
        : (rel as { code?: string } | null | undefined)?.code;
    const role = code && isRoleCode(code) ? code : null;
    const employeeId = r.employee_id ?? null;
    const tenantId = r.tenant_id ?? null;

    const teamMemberIds = new Set<string>();
    if (role === "acc_lead" && employeeId && r.tenant_id) {
      // ทีมที่ผู้ใช้เป็นหัวหน้า → สมาชิกปัจจุบัน (valid_to null)
      const { data: teams } = await db
        .from("teams")
        .select("id")
        .eq("tenant_id", r.tenant_id)
        .eq("lead_employee_id", employeeId)
        .is("deleted_at", null);
      const teamIds = (teams ?? []).map((t) => (t as { id: string }).id);
      if (teamIds.length > 0) {
        const { data: members } = await db
          .from("team_members")
          .select("employee_id")
          .eq("tenant_id", r.tenant_id)
          .in("team_id", teamIds)
          .is("valid_to", null)
          .is("deleted_at", null);
        for (const m of members ?? []) {
          const id = (m as { employee_id?: string }).employee_id;
          if (id) teamMemberIds.add(id);
        }
      }
    }

    return { role, employeeId, tenantId, teamMemberIds };
  } catch {
    return deny; // fail-closed
  }
}
