/**
 * Chat Audit dashboards — ชั้นตัดสินสิทธิ์ (allow-list / default-deny) — Phase 5a
 *   ★ ฟังก์ชันบริสุทธิ์ (ไม่แตะ DB) → unit test ได้แน่นอน
 *
 *   หลักสำคัญ (ยึดกติกาโมดูล):
 *     - executive/admin/auditor_qa : เห็นภาพรวมทั้ง tenant (auditor_qa อ่านอย่างเดียว)
 *     - acc_lead                   : เห็น "ทีมตัวเอง" (owner ∈ teamMemberIds)
 *     - accountant                 : เห็น "ของตัวเองเท่านั้น" (owner = employeeId)
 *     - cs                         : เห็น "ลูกค้าเสี่ยง" (risk) ทั้ง tenant — ไม่เห็นแชตดิบ
 *     - hr                         : ★ ไม่เห็นแชตดิบ/เคส (ใช้หน้า evaluation เดิมดูคะแนน confirmed)
 *     - role null/ไม่รู้จัก         : ปฏิเสธเสมอ (default deny)
 *
 *   ★ decrypt เนื้อหาแชต (content_enc/display_name_enc) อนุญาตเฉพาะ tier ที่มีสิทธิ์เท่านั้น
 *     (canDecryptChat) — hr ถูกตัดออกเด็ดขาดเหมือน canViewEvidence ใน evaluation/access
 */
import type { RoleCode } from "@/lib/dashboard/types";
import { isTeamLeadOf, type Viewer } from "@/lib/evaluation/access";

/** บทบาทที่เห็นภาพรวมแชตทั้ง tenant (privileged) */
export const CHAT_PRIVILEGED_ROLES: readonly RoleCode[] = [
  "admin",
  "executive",
  "auditor_qa",
] as const;

/** บทบาทที่เห็น "ลูกค้าเสี่ยง" ทั้ง tenant (privileged + cs) */
export const CHAT_RISK_TENANT_ROLES: readonly RoleCode[] = [
  "admin",
  "executive",
  "auditor_qa",
  "cs",
] as const;

function inList(role: string | null | undefined, list: readonly RoleCode[]): boolean {
  return !!role && (list as readonly string[]).includes(role);
}

/** true = บทบาทเห็นภาพรวมทั้ง tenant (admin/executive/auditor_qa) */
export function isChatPrivileged(role: string | null | undefined): boolean {
  return inList(role, CHAT_PRIVILEGED_ROLES);
}

// ---------------------------------------------------------------------
// สิทธิ์เข้าถึง "หน้า" (route guard / nav visibility) — allow-list
// ---------------------------------------------------------------------
/** Executive Dashboard — admin/executive/auditor_qa */
export function canSeeExecDashboard(role: string | null | undefined): boolean {
  return isChatPrivileged(role);
}

/** Team Leader Dashboard — acc_lead (privileged ก็ดูได้ แต่ต้องเลือกทีม → เน้น acc_lead) */
export function canSeeTeamDashboard(role: string | null | undefined): boolean {
  return role === "acc_lead";
}

/** Accountant Dashboard — accountant (ของตัวเอง) */
export function canSeeMeDashboard(role: string | null | undefined): boolean {
  return role === "accountant";
}

/** Customer Risk Dashboard — privileged + cs + acc_lead(ทีมตน) */
export function canSeeRiskDashboard(role: string | null | undefined): boolean {
  return inList(role, CHAT_RISK_TENANT_ROLES) || role === "acc_lead";
}

/** เปิด "ตัวดูแชต+วิเคราะห์เคส" ได้ไหม (ก่อนรู้ owner) — privileged/acc_lead/accountant */
export function canAccessChatViewer(role: string | null | undefined): boolean {
  return isChatPrivileged(role) || role === "acc_lead" || role === "accountant";
}

// ---------------------------------------------------------------------
// Decrypt gating — ★ ถอดรหัสเนื้อหาแชตได้ไหม (ต่อ "เจ้าของเคส")
//   เหมือน canViewEvidence: privileged/team-lead/own — ★ ตัด hr และ cs (ไม่เห็นแชตดิบ)
// ---------------------------------------------------------------------
export function canDecryptChat(
  viewer: Viewer,
  ownerEmployeeId: string | null | undefined
): boolean {
  if (!viewer.role) return false; // default deny
  if (viewer.role === "hr" || viewer.role === "cs") return false; // ★ ไม่เห็นแชตดิบ
  if (isChatPrivileged(viewer.role)) return true;
  if (ownerEmployeeId && isTeamLeadOf(viewer, ownerEmployeeId)) return true;
  // accountant: เฉพาะเคสที่ตัวเองเป็น owner
  return !!viewer.employeeId && !!ownerEmployeeId && viewer.employeeId === ownerEmployeeId;
}

// ---------------------------------------------------------------------
// Scope ของ "เคส/ความเสี่ยง" (conversation_cases / risk_alerts) ต่อบทบาท
//   ★ RLS ทำแค่ tenant isolation → ต้อง scope ต่อ owner ที่ app-layer เอง (default deny)
// ---------------------------------------------------------------------
export type CaseScope =
  | { kind: "all" }
  | { kind: "owner"; employeeId: string }
  | { kind: "team"; employeeIds: string[] }
  | { kind: "deny" };

/**
 * ตัดสิน scope การอ่านเคส/ความเสี่ยงของผู้ใช้:
 *   - privileged/cs → all (ทั้ง tenant)
 *   - acc_lead      → team (owner ∈ teamMemberIds; ถ้าไม่มีสมาชิก → deny กัน leak)
 *   - accountant    → owner (เฉพาะ employeeId ตัวเอง)
 *   - hr/อื่น/null   → deny
 */
export function caseScopeForViewer(viewer: Viewer): CaseScope {
  if (!viewer.role) return { kind: "deny" };
  if (inList(viewer.role, CHAT_RISK_TENANT_ROLES)) return { kind: "all" };
  if (viewer.role === "acc_lead") {
    const ids = [...(viewer.teamMemberIds ?? [])];
    // หัวหน้าเห็นของลูกทีม (+ ของตัวเองถ้ามี) — ไม่มีลูกทีมเลย = deny (กันหลุดทั้ง tenant)
    if (viewer.employeeId) ids.push(viewer.employeeId);
    return ids.length > 0 ? { kind: "team", employeeIds: [...new Set(ids)] } : { kind: "deny" };
  }
  if (viewer.role === "accountant") {
    return viewer.employeeId
      ? { kind: "owner", employeeId: viewer.employeeId }
      : { kind: "deny" };
  }
  return { kind: "deny" };
}
