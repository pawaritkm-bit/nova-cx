/**
 * หน้าหลักหลัง login — เลือก "หน้าออดิท/ตรวจแชต" ตามบทบาท
 *
 *   โปรแกรมนี้เน้น AI อ่านแชตมาวิเคราะห์ (ออดิท) เป็นหลัก ส่วนแบบประเมิน CSAT เป็นรอง
 *   → หลัง login ให้เด้งไปหน้าออดิทที่บทบาทนั้น "เข้าได้" ตามลำดับความสำคัญ
 *     ถ้าบทบาทไม่มีหน้าออดิทที่เข้าได้เลย (เช่น hr/sales) → fallback ไป /dashboard (CSAT เดิม)
 *
 *   ★ ฟังก์ชันบริสุทธิ์ (ไม่แตะ DB/session) → unit test ได้แน่นอน
 *   ★ ไม่ใช่ชั้นบังคับสิทธิ์ — สิทธิ์จริงยังคุมที่ guard/หน้า/RLS เหมือนเดิม
 *     (path ที่คืนมาต้องตรงกับ allow-list ของหน้านั้น เพื่อไม่ให้ผู้ใช้ไปจบหน้าที่โดน redirect)
 */
import {
  canSeeExecDashboard,
  canSeeTeamDashboard,
  canSeeMeDashboard,
  canSeeRiskDashboard,
} from "@/lib/chat-dashboard/access";
import type { RoleCode } from "@/lib/dashboard/types";

/** path ที่ใช้เป็น fallback เมื่อบทบาทไม่มีหน้าออดิทที่เข้าได้ (หน้า CSAT เดิม) */
export const HOME_FALLBACK_PATH = "/dashboard";

/**
 * คืน path หน้าหลักหลัง login ตามบทบาท (เรียงตามลำดับความสำคัญของหน้าออดิท):
 *   1. ภาพรวมทั้ง tenant (admin/executive/auditor_qa) → /chat-audit
 *   2. หัวหน้าทีม (acc_lead)                           → /chat-audit/team
 *   3. นักบัญชี (accountant)                           → /chat-audit/me
 *   4. เห็นลูกค้าเสี่ยง (cs)                            → /chat-audit/risk
 *   5. อื่น ๆ (hr/sales/sales_lead/role null)          → /dashboard (CSAT)
 */
export function resolveHomePath(role: RoleCode | null | undefined): string {
  if (canSeeExecDashboard(role)) return "/chat-audit";
  if (canSeeTeamDashboard(role)) return "/chat-audit/team";
  if (canSeeMeDashboard(role)) return "/chat-audit/me";
  if (canSeeRiskDashboard(role)) return "/chat-audit/risk";
  return HOME_FALLBACK_PATH;
}
