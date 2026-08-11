/**
 * แจ้งเตือนวันครบกำหนดยื่น ภ.ง.ด.1/สปส.1-10 — เฟส 9b กลุ่ม BG/ข้อ 7
 *   (docs/06-accounting-features-roadmap.md, หมวด 0.6, T168-T174)
 *
 * บริบท/เหตุผลสถาปัตยกรรม (0.6 reframe): `lib/line/notify.ts::processNotifJob` ผูกกับ `survey_invitations`
 *   ตรงตัว (โหลด `invitation_id`, ใช้ LIFF URL แบบสำรวจ) — enqueue payload ประเภทใหม่เข้า `job_queue`
 *   queue=`notification` จะพังทันที (`fail("missing_invitation_id")` วนซ้ำ) จึงสร้างระบบนี้แยกอิสระสมบูรณ์:
 *   ไม่มี LINE/อีเมลออก — ผลลัพธ์คือ log กันแจ้งเตือนซ้ำ (`payroll_filing_reminders`) + แถบแจ้งเตือนในหน้าจอ
 *   payroll/page.tsx ที่นักบัญชีเห็นอยู่แล้วทุกวัน (ไม่มีช่องทางส่งข้อความหานักบัญชีภายใน Finovas โดยเฉพาะ —
 *   นอกสโคปเฟสนี้)
 *
 * กำหนดยื่นที่ใช้ (ตามคำสั่งผู้ใช้): มาตรฐานสรรพากร วันที่ 15 ของเดือนถัดไปเสมอ ทั้ง ภ.ง.ด.1 และ สปส.1-10
 *   (ภ.ง.ด.1 บังคับยื่นออนไลน์ตั้งแต่ ม.ค. 2567 จึงใช้ 15 เสมอ ไม่ใช้กติกา 7 วันแบบกระดาษเดิม) — ผู้ใช้จะปรับ
 *   เปลี่ยนกติกานี้เองในอนาคตถ้าจำเป็น — `calcPitDeadline`/`calcSsoDeadline` แยกฟังก์ชันกันชัดเจนแม้สูตรวันนี้
 *   เหมือนกัน (กันแก้ผิดฟังก์ชันถ้าอนาคตกติกาแยกกันจริง — mirror หลักการตั้งชื่อ 0.7 เดิม)
 *
 * ★ [⚠️ FLAG] ไม่ปรับวันหยุดราชการอัตโนมัติ (ไม่มี API ปฏิทินวันหยุดราชการที่เชื่อถือได้ฟรี) — ชดเชยด้วย
 *   buffer แจ้งเตือนล่วงหน้า 3 วัน (`due_soon`) + แจ้งซ้ำทุกวันที่เกินกำหนด (`overdue`) จนกว่าจะยื่น
 * ★ pay_period_year/period_year เก็บเป็น **พ.ศ.** ทั้งระบบ (mirror payroll-prorate.ts) — แปลงเป็น ค.ศ. (-543)
 *   ก่อนคำนวณวันครบกำหนดจริง เพราะ `today` (todayIsoThai()) เป็น ISO ค.ศ.
 * ★ ทุก query scan ทุก tenant ใช้ service-role client เท่านั้น (เรียกจาก cron) — ไม่มี IDOR risk เพราะไม่มี
 *   input จาก user เลย; ฟังก์ชันอ่านสำหรับ UI (`listActiveFilingReminders`) กรอง tenant_id+customer_id เสมอ
 *   (เรียกจาก payroll/page.tsx ที่ผ่าน resolveAccountingAccess + validCustomerId ที่ scope ไว้แล้วชั้นบน)
 * ★ PDPA: ไม่ log ชื่อลูกค้า/พนักงาน/ยอดเงินที่ไหนในไฟล์นี้
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type DB = SupabaseClient;

const BUDDHIST_YEAR_OFFSET = 543;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** วันครบกำหนดยื่น ภ.ง.ด.1 ของงวด (periodYear เป็น พ.ศ. ตาม payroll_monthly_filings.period_year,
 *  periodMonth 1-12) = วันที่ 15 ของเดือนถัดไป (คืน ISO ค.ศ. "YYYY-MM-DD" เทียบกับ todayIsoThai() ได้ตรง) —
 *  ข้ามปีถูกต้อง (เดือน 12 → เดือน 1 ปีถัดไป), ไม่กระทบจากปีอธิกสุรทิน (วันที่ 15 คงที่ไม่ใช่วันสุดท้ายของเดือน) */
export function calcPitDeadline(periodYear: number, periodMonth: number): string {
  const gYear = periodYear - BUDDHIST_YEAR_OFFSET;
  let nextMonth = periodMonth + 1;
  let nextYear = gYear;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  return `${nextYear}-${pad2(nextMonth)}-15`;
}

/** วันครบกำหนดยื่น สปส.1-10 ของงวด — สูตรวันนี้เหมือน calcPitDeadline เป๊ะ (วันที่ 15 เดือนถัดไป) แต่แยก
 *  ฟังก์ชันกันชัดเจนตามชื่อ (mirror 0.7) เผื่ออนาคตผู้ใช้ปรับกติกา สปส. ให้ต่างจาก ภ.ง.ด. แก้ที่นี่จุดเดียว
 *  ไม่กระทบ calcPitDeadline */
export function calcSsoDeadline(periodYear: number, periodMonth: number): string {
  const gYear = periodYear - BUDDHIST_YEAR_OFFSET;
  let nextMonth = periodMonth + 1;
  let nextYear = gYear;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  return `${nextYear}-${pad2(nextMonth)}-15`;
}

export type ReminderKind = "pit" | "sso";
export type ReminderStage = "due_soon" | "due_today" | "overdue";

/** จำนวนวัน (deadlineIso - todayIso) — ทั้งคู่เป็น ISO ค.ศ. "YYYY-MM-DD" — บวก = ยังไม่ถึงกำหนด, ลบ = เกินกำหนด */
function daysUntil(todayIso: string, deadlineIso: string): number {
  const [ty, tm, td] = todayIso.split("-").map(Number);
  const [dy, dm, dd] = deadlineIso.split("-").map(Number);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  const deadlineUtc = Date.UTC(dy, dm - 1, dd);
  return Math.round((deadlineUtc - todayUtc) / 86400000);
}

/**
 * stage ที่ควรแจ้งเตือน ณ วันนี้ เทียบกับวันครบกำหนด — คืน `null` ถ้ายังไม่ถึงช่วงที่ต้องแจ้ง
 *   - `due_soon`  : เหลืออีกพอดี 3 วันก่อนครบกำหนด (buffer เผื่อวันหยุดราชการที่อาจเลื่อน, ดู [⚠️ FLAG] บนไฟล์)
 *   - `due_today` : วันนี้ตรงกับวันครบกำหนดเป๊ะ
 *   - `overdue`   : เกินกำหนดแล้ว (ทุกวันหลังจากนั้นจนกว่าจะยื่น — ไม่มีวันหมดอายุการแจ้งเตือน)
 */
export function isReminderDue(deadline: string, today: string): ReminderStage | null {
  const diff = daysUntil(today, deadline);
  if (diff === 3) return "due_soon";
  if (diff === 0) return "due_today";
  if (diff < 0) return "overdue";
  return null;
}

// ---------------------------------------------------------------------
// generateDueReminders — orchestrator สำหรับ cron (T170)
// ---------------------------------------------------------------------

type RawMonthlyFilingRow = {
  id: string;
  tenant_id: string;
  period_year: number;
  period_month: number;
  pit_filing_status: string;
  sso_filing_status: string;
};

const CANDIDATE_LIMIT = 5000;

async function insertReminderIfDue(
  db: DB,
  tenantId: string,
  filingPeriodId: string,
  kind: ReminderKind,
  deadline: string,
  today: string
): Promise<"generated" | "skipped" | "not_due" | "failed"> {
  const stage = isReminderDue(deadline, today);
  if (!stage) return "not_due";
  try {
    const { error } = await db.from("payroll_filing_reminders").insert({
      tenant_id: tenantId,
      filing_period_id: filingPeriodId,
      kind,
      reminder_stage: stage,
      deadline,
    });
    if (!error) return "generated";
    // ★ 23505 = unique (filing_period_id, kind, reminder_stage) ชน — เคยแจ้ง stage นี้ไปแล้ว (dedup, ไม่ใช่ error จริง)
    if ((error as { code?: string }).code === "23505") return "skipped";
    return "failed";
  } catch {
    return "failed";
  }
}

export type GenerateDueRemindersSummary = {
  tenants: number;
  scannedPeriods: number;
  checked: number;
  generated: number;
  skipped: number;
  failed: number;
};

/**
 * สแกน `payroll_monthly_filings` ทุก tenant (service-role, ไม่ผูก tenant เดียว — mirror
 *   `generateForAllTenants` ของ `app/api/cron/generate-recurring-je/route.ts`) หาแถวที่
 *   `pit_filing_status='not_filed'` หรือ `sso_filing_status='not_filed'` แล้วเช็ค `isReminderDue` ต่อ kind
 *   ที่ยังไม่ยื่น → insert `payroll_filing_reminders` (dedup ด้วย unique index ที่ชั้น DB — insert ทีละแถว
 *   กันไม่ให้แถวชนกันตัวเดียวทำให้ทั้ง batch ล้มเหลว, error 23505 ถือเป็น "ข้าม" ไม่ใช่ "พัง")
 */
export async function generateDueReminders(db: DB, today: string): Promise<GenerateDueRemindersSummary> {
  const { data, error } = await db
    .from("payroll_monthly_filings")
    .select("id, tenant_id, period_year, period_month, pit_filing_status, sso_filing_status")
    .limit(CANDIDATE_LIMIT);
  if (error) return { tenants: 0, scannedPeriods: 0, checked: 0, generated: 0, skipped: 0, failed: 0 };

  const rows = (data ?? []) as RawMonthlyFilingRow[];
  const candidates = rows.filter((r) => r.pit_filing_status === "not_filed" || r.sso_filing_status === "not_filed");

  const tenantIds = new Set<string>();
  let checked = 0;
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of candidates) {
    tenantIds.add(row.tenant_id);
    if (row.pit_filing_status === "not_filed") {
      checked++;
      const deadline = calcPitDeadline(row.period_year, row.period_month);
      const r = await insertReminderIfDue(db, row.tenant_id, row.id, "pit", deadline, today);
      if (r === "generated") generated++;
      else if (r === "skipped") skipped++;
      else if (r === "failed") failed++;
    }
    if (row.sso_filing_status === "not_filed") {
      checked++;
      const deadline = calcSsoDeadline(row.period_year, row.period_month);
      const r = await insertReminderIfDue(db, row.tenant_id, row.id, "sso", deadline, today);
      if (r === "generated") generated++;
      else if (r === "skipped") skipped++;
      else if (r === "failed") failed++;
    }
  }

  return { tenants: tenantIds.size, scannedPeriods: candidates.length, checked, generated, skipped, failed };
}

// ---------------------------------------------------------------------
// listActiveFilingReminders — สำหรับ banner หน้าจอ payroll/page.tsx (T173)
// ---------------------------------------------------------------------

type RawFilingPeriodRow = {
  id: string;
  period_year: number;
  period_month: number;
  pit_filing_status: string;
  sso_filing_status: string;
};

type RawReminderRow = {
  filing_period_id: string;
  kind: string;
  reminder_stage: string;
  deadline: string;
  created_at: string;
};

export type FilingReminderBannerItem = {
  filingPeriodId: string;
  periodYear: number;
  periodMonth: number;
  kind: ReminderKind;
  stage: ReminderStage;
  deadline: string;
};

const PERIOD_SCAN_LIMIT = 500;
const REMINDER_SCAN_LIMIT = 1000;

/**
 * รายการหน่วยยื่นของลูกค้า 1 ราย ที่ยังใกล้/เกินกำหนด (มี reminder ล่าสุดของ kind นั้น ๆ ที่ยังไม่ถูกยื่นจริง) —
 *   ใช้แสดง banner ในหน้า payroll/page.tsx (T173) — คืน `[]` ถ้าลูกค้ายื่นครบทุกเดือนแล้ว (ไม่มี banner)
 * ★ ใช้สถานะยื่นปัจจุบันจริงของ `payroll_monthly_filings` เป็นตัวชี้ขาด (ไม่ใช่แค่มี reminder log ค้างอยู่) —
 *   ถ้ายื่นไปแล้วหลังจากที่เคยมี reminder ก่อนหน้า banner ต้องหายไปทันที
 * ★ IDOR-safe: กรอง tenant_id + customer_id เสมอ — เรียกจาก payroll/page.tsx ที่ validCustomerId ผ่าน
 *   fetchScopedCustomers (derive จาก access.tenantId) มาแล้วชั้นบน
 */
export async function listActiveFilingReminders(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<FilingReminderBannerItem[]> {
  const { data: periodData } = await db
    .from("payroll_monthly_filings")
    .select("id, period_year, period_month, pit_filing_status, sso_filing_status")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .limit(PERIOD_SCAN_LIMIT);

  const periods = (periodData ?? []) as RawFilingPeriodRow[];
  const pendingPeriods = periods.filter(
    (p) => p.pit_filing_status === "not_filed" || p.sso_filing_status === "not_filed"
  );
  if (pendingPeriods.length === 0) return [];

  const periodIds = pendingPeriods.map((p) => p.id);
  const { data: reminderData } = await db
    .from("payroll_filing_reminders")
    .select("filing_period_id, kind, reminder_stage, deadline, created_at")
    .eq("tenant_id", tenantId)
    .in("filing_period_id", periodIds)
    .order("created_at", { ascending: false })
    .limit(REMINDER_SCAN_LIMIT);
  const reminders = (reminderData ?? []) as RawReminderRow[];

  // ★ เก็บเฉพาะ reminder ล่าสุดต่อ (filing_period_id, kind) — stage เก่าที่ถูกแทนที่แล้วไม่ต้องแสดงซ้ำ
  const latestByKey = new Map<string, RawReminderRow>();
  for (const r of reminders) {
    const key = `${r.filing_period_id}:${r.kind}`;
    const prev = latestByKey.get(key);
    if (!prev || r.created_at > prev.created_at) latestByKey.set(key, r);
  }

  const periodById = new Map(pendingPeriods.map((p) => [p.id, p] as const));
  const items: FilingReminderBannerItem[] = [];
  for (const r of latestByKey.values()) {
    const period = periodById.get(r.filing_period_id);
    if (!period) continue;
    const kind = r.kind as ReminderKind;
    const stillPending =
      (kind === "pit" && period.pit_filing_status === "not_filed") ||
      (kind === "sso" && period.sso_filing_status === "not_filed");
    if (!stillPending) continue;
    items.push({
      filingPeriodId: r.filing_period_id,
      periodYear: period.period_year,
      periodMonth: period.period_month,
      kind,
      stage: r.reminder_stage as ReminderStage,
      deadline: r.deadline,
    });
  }
  return items;
}

/** จำนวนหน่วยยื่น (distinct filing period) ที่ใกล้/เกินกำหนด — ใช้แสดงตัวเลขบน banner ("⚠️ N หน่วยยื่น...") */
export function countPendingFilingUnits(items: FilingReminderBannerItem[]): number {
  return new Set(items.map((i) => i.filingPeriodId)).size;
}
