/**
 * หา "บทบาทผู้ชม" ของ dashboard
 *   - หลัก: จาก session พนักงาน (users → roles.code ตาม auth.uid())
 *   - fallbackParam (?role=): ใช้ได้เฉพาะ "โหมดตัวอย่าง" ของหน้า UI (app/dashboard/page.tsx)
 *     เพื่อพรีวิวหน้าตาแต่ละบทบาทตอนยังไม่มี auth login เต็ม
 *     ★ M3: API endpoint (/api/dashboard, /api/reports/export) "ห้าม" ส่ง fallbackParam
 *       — ต้องบังคับ session จริง (เช็ค hasSession) ไม่ให้ param กำหนด composition
 *     ★ ต่อให้ปลอม ?role=executive ข้อมูลที่เห็นยังบังคับด้วย view/RLS ตาม auth.uid() เสมอ
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
