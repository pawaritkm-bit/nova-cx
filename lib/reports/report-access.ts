/**
 * สิทธิ์ "เห็นเมนู/เข้าหน้ารายงานประเมินนักบัญชี" (Phase 5b) — ★ ฟังก์ชันบริสุทธิ์
 *   allow-list / default-deny:
 *     - executive/admin/auditor_qa : เห็นรายงานได้ (ทุกคน)
 *     - acc_lead                   : เห็น (ของทีมตัวเอง — scope จริงบังคับใน builder)
 *     - hr                         : เห็น (คะแนน confirmed เท่านั้น — บังคับใน builder)
 *     - accountant                 : เห็น (ของตัวเอง)
 *     - อื่น/null                   : ปฏิเสธ
 *   ★ นี่คือ nav-visibility เท่านั้น — สิทธิ์อ่านข้อมูลจริงบังคับที่ resolveReportAccess (per-employee)
 */
import type { RoleCode } from "@/lib/dashboard/types";

export const ACCOUNTANT_REPORT_ROLES: readonly RoleCode[] = [
  "executive",
  "admin",
  "auditor_qa",
  "acc_lead",
  "hr",
  "accountant",
] as const;

export function canSeeAccountantReport(role: string | null | undefined): boolean {
  if (!role) return false;
  return (ACCOUNTANT_REPORT_ROLES as readonly string[]).includes(role);
}
