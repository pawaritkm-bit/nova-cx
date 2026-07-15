import type { AiAnalysisResult, Urgency } from "./schema";

/**
 * Logic เปิดเคสอัตโนมัติ (E7) — pure functions (ไม่ยุ่ง DB, testable)
 *   - urgency High/Critical → เปิด complaint_cases
 *   - level = urgency (critical|high)
 *   - type อนุมานจากบริบท (retention/reassign_request/complaint)
 *   - SLA ตาม Q9: Critical ตอบใน 4 ชม.ทำการ, High ภายในวันทำการเดียวกัน
 *     เวลาทำการ จ–ศ 9:00–18:00 ตาม "เวลาไทย (Asia/Bangkok, UTC+7)"
 *
 * หลักการเวลา: แปลง instant (UTC) → เวลาไทยก่อนคิด business hours (ด้วยการเลื่อน +7 ชม.
 *   แล้วอ่านค่าด้วย getUTC* ซึ่งจะได้ค่า wall-clock ของไทย) แล้วเก็บผลกลับเป็น UTC (-7 ชม.)
 */

export type CaseLevel = "critical" | "high";
export type CaseType = "complaint" | "retention" | "reassign_request" | "positive";

const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 18;

/** ชดเชยเวลาไทย (UTC+7) เป็นมิลลิวินาที */
const THAI_OFFSET_MS = 7 * 60 * 60 * 1000;

/** UTC instant → date ที่ getUTC* คืนค่าเป็น wall-clock เวลาไทย */
function toThaiWall(d: Date): Date {
  return new Date(d.getTime() + THAI_OFFSET_MS);
}

/** date (wall-clock เวลาไทยผ่าน getUTC*) → UTC instant จริง */
function fromThaiWall(d: Date): Date {
  return new Date(d.getTime() - THAI_OFFSET_MS);
}

/** true เมื่อ urgency ต้องเปิดเคสอัตโนมัติ */
export function shouldOpenCase(urgency: Urgency): urgency is CaseLevel {
  return urgency === "critical" || urgency === "high";
}

/** อนุมาน type ของเคสจากผลวิเคราะห์ + ชนิดแบบประเมิน */
export function inferCaseType(
  analysis: Pick<AiAnalysisResult, "summary" | "categories" | "customer_facts">,
  surveyType: string
): CaseType {
  const text = [
    analysis.summary,
    ...analysis.categories,
    ...analysis.customer_facts,
  ]
    .join(" ")
    .toLowerCase();

  const hasCancel = /ยกเลิก|เลิกใช้|เลิกจ้าง|ไม่ต่อสัญญา|ย้ายสำนักงาน/.test(text);
  const hasReassign = /เปลี่ยนผู้ดูแล|เปลี่ยนนักบัญชี|ขอเปลี่ยนคน|ไม่อยากได้คนนี้/.test(text);

  if (hasReassign || (surveyType === "B" && /เปลี่ยน/.test(text))) {
    return "reassign_request";
  }
  if (hasCancel) return "retention";
  return "complaint";
}

/** ตรวจว่าเป็นวันทำการ (จ–ศ) — d ต้องเป็น wall-clock เวลาไทย (ผ่าน toThaiWall) */
function isBusinessDay(d: Date): boolean {
  const day = d.getUTCDay();
  return day >= 1 && day <= 5;
}

/**
 * เลื่อน date (wall-clock เวลาไทย) เข้าสู่ต้นช่วงเวลาทำการที่ใกล้ที่สุด (mutate ในตัว)
 *   นอกวันทำการ/ก่อน 9:00/หลัง 18:00 → เลื่อนไปเวลาเริ่มงานของวันทำการถัดที่เหมาะสม
 */
function clampToBusinessStart(d: Date): void {
  while (true) {
    if (!isBusinessDay(d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      continue;
    }
    const h = d.getUTCHours() + d.getUTCMinutes() / 60;
    if (h < BUSINESS_START_HOUR) {
      d.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
    } else if (h >= BUSINESS_END_HOUR) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      continue;
    }
    break;
  }
}

/**
 * บวก "ชั่วโมงทำการ" เข้ากับเวลาเริ่ม (นับเฉพาะ จ–ศ 9:00–18:00 เวลาไทย)
 *   คิดบน wall-clock ไทยแล้วคืนเป็น UTC instant
 */
export function addBusinessHours(start: Date, hours: number): Date {
  let remaining = hours * 60; // นาที
  const cur = toThaiWall(start);

  clampToBusinessStart(cur);

  while (remaining > 0) {
    const endOfDay = new Date(cur.getTime());
    endOfDay.setUTCHours(BUSINESS_END_HOUR, 0, 0, 0);
    const availMin = (endOfDay.getTime() - cur.getTime()) / 60000;

    if (remaining <= availMin) {
      cur.setUTCMinutes(cur.getUTCMinutes() + remaining);
      remaining = 0;
    } else {
      remaining -= availMin;
      // ข้ามไปต้นวันทำการถัดไป
      cur.setUTCDate(cur.getUTCDate() + 1);
      cur.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      clampToBusinessStart(cur);
    }
  }
  return fromThaiWall(cur);
}

/**
 * คำนวณ sla_due_at
 *   - critical: ตอบใน 4 ชม.ทำการ
 *   - high: ภายในวันทำการเดียวกัน (= สิ้นเวลาทำการ 18:00 เวลาไทยของวันทำการที่พร้อม)
 */
export function computeSlaDueAt(level: CaseLevel, now: Date = new Date()): Date {
  if (level === "critical") {
    return addBusinessHours(now, 4);
  }
  // high → สิ้นวันทำการ (18:00 เวลาไทย) ของวันทำการที่เกี่ยวข้อง
  const cur = toThaiWall(now);
  clampToBusinessStart(cur);
  cur.setUTCHours(BUSINESS_END_HOUR, 0, 0, 0);
  return fromThaiWall(cur);
}
