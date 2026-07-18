/**
 * นับ "เวลาทำการ" ระหว่างสองเวลา (Phase 4) — ★ ฟังก์ชันบริสุทธิ์ testable
 *   ใช้กติกาเดียวกับ lib/ai/case.ts (จ–ศ 9:00–18:00 เวลาไทย Asia/Bangkok UTC+7)
 *   + เพิ่มการยกเว้น "วันหยุด/วันลา" (holidays) → เวลาช่วงนั้นไม่นับ
 *
 * ★ เหตุผล (กติกาผู้ใช้ข้อ 4): ห้ามลดคะแนนจากข้อความนอกเวลางาน/วันลา/วันหยุด/เหตุนอกการควบคุม
 *   → "เวลาตอบสนอง" ต้องนับเฉพาะเวลาทำการเท่านั้น
 *   ตัวอย่าง: ลูกค้าทักศุกร์ 17:30 นักบัญชีตอบจันทร์ 9:30 → นับ = 60 นาที
 *     (ศุกร์ 17:30–18:00 = 30 + จันทร์ 9:00–9:30 = 30) ไม่ใช่ทั้งสุดสัปดาห์
 *
 * แนวคิดเวลา (เหมือน case.ts): เลื่อน instant (UTC) เป็น wall-clock ไทย (+7 ชม.)
 *   แล้วอ่านด้วย getUTC* → ได้ค่าเวลาไทย
 */

const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 18;
const THAI_OFFSET_MS = 7 * 60 * 60 * 1000;

/** UTC instant → date ที่ getUTC* คืนค่าเป็น wall-clock เวลาไทย */
function toThaiWall(d: Date): Date {
  return new Date(d.getTime() + THAI_OFFSET_MS);
}

/** yyyy-mm-dd ของ wall-clock (ใช้เทียบ holiday set) */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** true = เป็นวันทำการ (จ–ศ) และไม่ใช่วันหยุด/วันลา */
function isWorkingDay(wall: Date, holidays: ReadonlySet<string>): boolean {
  const day = wall.getUTCDay();
  if (day === 0 || day === 6) return false; // เสาร์/อาทิตย์
  return !holidays.has(ymd(wall));
}

/**
 * นับนาทีทำการระหว่าง start → end (เฉพาะ จ–ศ 9:00–18:00 เวลาไทย, ตัดวันหยุด)
 *   - end <= start → 0
 *   - holidays : เซ็ตของ 'yyyy-mm-dd' (เวลาไทย) ที่ไม่นับ (วันหยุด/วันลาของพนักงาน)
 */
export function businessMinutesBetween(
  start: Date,
  end: Date,
  holidays: ReadonlySet<string> = new Set()
): number {
  if (end.getTime() <= start.getTime()) return 0;

  const s = toThaiWall(start);
  const e = toThaiWall(end);
  let minutes = 0;

  // เดินทีละวัน (wall-clock ไทย) ตั้งแต่วันของ start ถึงวันของ end
  const cursor = new Date(s.getTime());
  cursor.setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() <= e.getTime()) {
    if (isWorkingDay(cursor, holidays)) {
      // ช่วงเวลาทำการของวันนี้ (wall-clock)
      const dayOpen = new Date(cursor.getTime());
      dayOpen.setUTCHours(BUSINESS_START_HOUR, 0, 0, 0);
      const dayClose = new Date(cursor.getTime());
      dayClose.setUTCHours(BUSINESS_END_HOUR, 0, 0, 0);

      // ตัดด้วยช่วง [s, e]
      const from = Math.max(dayOpen.getTime(), s.getTime());
      const to = Math.min(dayClose.getTime(), e.getTime());
      if (to > from) minutes += (to - from) / 60000;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return Math.round(minutes);
}

/** helper: สร้าง holiday set จาก array 'yyyy-mm-dd' (best-effort, ข้ามค่าว่าง) */
export function toHolidaySet(days: (string | null | undefined)[] = []): Set<string> {
  const set = new Set<string>();
  for (const d of days) {
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) set.add(d);
  }
  return set;
}
