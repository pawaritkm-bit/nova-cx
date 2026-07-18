/**
 * Tier access guard (Phase 4) — ★ ฟังก์ชันบริสุทธิ์ (allow-list / default-deny)
 *   สะท้อน RLS ใน 0035 มาบังคับซ้ำที่ app-layer (server action/query) ก่อนอ่าน/เขียน
 *
 *   ★ กติกาสำคัญ:
 *     - accountant : เห็น eval "ของตัวเองเท่านั้น" (ห้ามเห็นของคนอื่นเด็ดขาด)
 *     - acc_lead   : เห็น + review/confirm "ทีมตัวเอง"
 *     - executive/admin/auditor_qa : เห็นทั้งหมด (auditor_qa อ่านอย่างเดียว ไม่ confirm)
 *     - hr         : เห็นเฉพาะ eval ที่ confirmed (คะแนน) — ★ ไม่เห็น evidence แชตดิบ
 *     - อุทธรณ์    : เฉพาะเจ้าของ eval (นักบัญชี) เท่านั้น
 *
 *   caller ต้อง resolve teamMemberIds (พนักงานที่ผู้ใช้ acc_lead เป็นหัวหน้า) มาก่อน
 *   (จาก team_members + teams.lead_employee_id) — ที่นี่ตัดสินเชิงตรรกะเท่านั้น
 */
import type { RoleCode } from "@/lib/dashboard/types";

/** สถานะ eval ที่ถือว่า "ตัดสินแล้ว" (hr เห็นได้) */
export const CONFIRMED_STATUSES: ReadonlySet<string> = new Set([
  "manager_confirmed",
  "manager_edited",
  "appeal_resolved",
]);

/** สถานะ eval ที่อุทธรณ์ได้ (หลังหัวหน้าตัดสิน) */
export const APPEALABLE_STATUSES: ReadonlySet<string> = new Set([
  "manager_confirmed",
  "manager_edited",
]);

/** บทบาทที่เห็น eval ทั้ง tenant */
export const EVAL_PRIVILEGED_ROLES: readonly RoleCode[] = [
  "admin",
  "executive",
  "auditor_qa",
] as const;

/** บทบาทที่ "ยืนยัน/แก้/ปฏิเสธ" eval ระดับ tenant ได้ (auditor_qa อ่านอย่างเดียว → ไม่รวม) */
export const EVAL_MANAGER_ROLES: readonly RoleCode[] = ["admin", "executive"] as const;

export type Viewer = {
  role: RoleCode | null;
  /** employee_id ของผู้ใช้ปัจจุบัน (null = ไม่ผูกพนักงาน เช่น admin บางราย) */
  employeeId: string | null;
  /** พนักงานที่ผู้ใช้ (acc_lead) เป็นหัวหน้าทีม — resolve มาจาก DB */
  teamMemberIds?: ReadonlySet<string>;
};

function inList(role: string | null, list: readonly RoleCode[]): boolean {
  return !!role && (list as readonly string[]).includes(role);
}

/** true = ผู้ใช้เป็นหัวหน้าทีมของ employee เป้าหมาย (acc_lead + อยู่ในทีมที่ตนนำ) */
export function isTeamLeadOf(viewer: Viewer, targetEmployeeId: string): boolean {
  return viewer.role === "acc_lead" && !!viewer.teamMemberIds?.has(targetEmployeeId);
}

/**
 * เห็น "คะแนน" eval ของ employee นี้ได้ไหม (tier)
 *   ★ default deny — role null/ไม่รู้จัก = false เสมอ
 */
export function canViewEvaluation(
  viewer: Viewer,
  targetEmployeeId: string,
  status: string
): boolean {
  if (!viewer.role) return false; // default deny — ไม่มีบทบาท = ไม่เห็นเด็ดขาด
  if (inList(viewer.role, EVAL_PRIVILEGED_ROLES)) return true;
  if (viewer.role === "hr") return CONFIRMED_STATUSES.has(status);
  if (isTeamLeadOf(viewer, targetEmployeeId)) return true;
  // accountant/อื่น ๆ: เฉพาะของตัวเอง
  return !!viewer.employeeId && viewer.employeeId === targetEmployeeId;
}

/**
 * เห็น "หลักฐานแชตดิบ" (evidence/coaching/appeal) ได้ไหม
 *   ★ เหมือน eval แต่ "ตัด hr" (hr เห็นแค่คะแนน ไม่เห็น evidence)
 */
export function canViewEvidence(viewer: Viewer, targetEmployeeId: string): boolean {
  if (!viewer.role) return false; // default deny
  if (viewer.role === "hr") return false;
  if (inList(viewer.role, EVAL_PRIVILEGED_ROLES)) return true;
  if (isTeamLeadOf(viewer, targetEmployeeId)) return true;
  return !!viewer.employeeId && viewer.employeeId === targetEmployeeId;
}

/**
 * review/confirm/edit/reject eval ของ employee นี้ได้ไหม
 *   = admin/executive (ทั้ง tenant) หรือ acc_lead ของทีมนั้น
 *   ★ accountant/hr/auditor_qa "ทำไม่ได้" (auditor_qa อ่านอย่างเดียว)
 */
export function canReviewEvaluation(viewer: Viewer, targetEmployeeId: string): boolean {
  if (inList(viewer.role, EVAL_MANAGER_ROLES)) return true;
  return isTeamLeadOf(viewer, targetEmployeeId);
}

/**
 * ยื่นอุทธรณ์ eval นี้ได้ไหม
 *   ★ เฉพาะ "เจ้าของ eval" (นักบัญชีคนนั้น) + สถานะต้องอุทธรณ์ได้
 */
export function canAppeal(
  viewer: Viewer,
  targetEmployeeId: string,
  status: string
): boolean {
  if (!viewer.role) return false; // default deny
  if (!viewer.employeeId || viewer.employeeId !== targetEmployeeId) return false;
  return APPEALABLE_STATUSES.has(status);
}

/** resolve อุทธรณ์ได้ไหม (หัวหน้า/ผู้บริหาร) — เหมือน review */
export function canResolveAppeal(viewer: Viewer, targetEmployeeId: string): boolean {
  return canReviewEvaluation(viewer, targetEmployeeId);
}
