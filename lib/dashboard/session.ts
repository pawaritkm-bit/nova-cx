/**
 * หา "บทบาทผู้ชม" ของ dashboard
 *   - หลัก: จาก session พนักงาน (users → roles.code ตาม auth.uid())
 *   - ชั่วคราว (chunk 5 ยังไม่มี auth login เต็ม): fallback จาก query param ?role=
 *     ★ param มีผลแค่ "เลือกหน้าไหน" — ข้อมูลที่เห็นยังบังคับด้วย view/RLS ตาม auth เสมอ
 *       ต่อให้ปลอม ?role=executive ก็ไม่เห็นข้อมูลเกินสิทธิ์จริง
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isRoleCode, type RoleCode } from "./types";

export type Viewer = {
  role: RoleCode | null;
  /** true = มาจาก session จริง, false = มาจาก param ชั่วคราว */
  fromSession: boolean;
  hasSession: boolean;
};

export async function resolveViewer(
  db: SupabaseClient,
  fallbackParam?: string | null
): Promise<Viewer> {
  let hasSession = false;
  try {
    const { data } = await db.auth.getUser();
    if (data?.user) {
      hasSession = true;
      const { data: row } = await db
        .from("users")
        .select("roles(code)")
        .eq("auth_user_id", data.user.id)
        .maybeSingle();
      // roles(code) อาจมาเป็น object หรือ array แล้วแต่ shape ที่ join
      const rel = (row as { roles?: unknown } | null)?.roles;
      const code =
        Array.isArray(rel) && rel.length > 0
          ? (rel[0] as { code?: string }).code
          : (rel as { code?: string } | null | undefined)?.code;
      if (code && isRoleCode(code)) {
        return { role: code, fromSession: true, hasSession };
      }
    }
  } catch {
    // ไม่มี auth/ต่อ DB ไม่ได้ → ตกไป fallback
  }

  if (fallbackParam && isRoleCode(fallbackParam)) {
    return { role: fallbackParam, fromSession: false, hasSession };
  }
  return { role: null, fromSession: false, hasSession };
}

/** map role → "กลุ่มหน้า dashboard" ที่จะประกอบ */
export type DashboardView = "exec" | "member" | "lead";

export function dashboardViewForRole(role: RoleCode): DashboardView {
  switch (role) {
    case "executive":
    case "admin":
    case "cs":
      return "exec";
    case "acc_lead":
    case "sales_lead":
      return "lead";
    case "accountant":
    case "sales":
      return "member";
    default:
      return "member";
  }
}
