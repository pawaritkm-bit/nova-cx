import type { CaseLevel } from "@/lib/ai/case";

/**
 * Risk level mapping (Phase 3) — ★ ฟังก์ชันบริสุทธิ์
 *   แปลงสถานะ SLA breach + sentiment/ปัญหา → ระดับความเสี่ยง 4 ระดับ
 *     green  = ปกติ
 *     yellow = ติดตาม (ใกล้ครบ SLA / sentiment ลบเริ่มมี)
 *     orange = เสี่ยงร้องเรียน (เลย SLA ตอบครั้งแรก / critical + ลบ)
 *     red    = หัวหน้าด่วน (เลย SLA ปิดงาน หรือถูก escalate ไปหัวหน้าแล้ว)
 */

export type RiskLevel = "green" | "yellow" | "orange" | "red";

export type RiskInput = {
  responseBreached?: boolean;
  resolutionBreached?: boolean;
  responseDueSoon?: boolean;
  resolutionDueSoon?: boolean;
  level: CaseLevel | string;
  sentiment?: string | null;
  problemCount?: number;
  escalated?: boolean;
};

/** อันดับความรุนแรงของ risk level (ยิ่งมากยิ่งรุนแรง) — ใช้ "ยก" ระดับ ไม่ให้ลดเอง */
const RISK_RANK: Record<RiskLevel, number> = {
  green: 0,
  yellow: 1,
  orange: 2,
  red: 3,
};

export function riskRank(level: RiskLevel): number {
  return RISK_RANK[level];
}

/** คืน level ที่รุนแรงกว่าระหว่างสองค่า (ใช้ยกระดับ alert เดิม) */
export function maxRiskLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

/** map สถานะ SLA + บริบทวิเคราะห์ → risk level */
export function computeRiskLevel(input: RiskInput): RiskLevel {
  if (input.resolutionBreached || input.escalated) return "red";
  if (input.responseBreached) return "orange";
  const negative = input.sentiment === "negative";
  const hasProblems = (input.problemCount ?? 0) > 0;
  // critical + ลบ = เสี่ยงร้องเรียนแม้ยังไม่ถึงกำหนด
  if (negative && (input.level === "critical" || hasProblems)) return "orange";
  if (input.responseDueSoon || input.resolutionDueSoon) return "yellow";
  if (negative) return "yellow";
  return "green";
}
