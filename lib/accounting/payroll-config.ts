/**
 * ค่าคงที่ทางกฎหมาย (global, ไม่ผูก tenant) ที่ระบบเงินเดือนต้องใช้ — data layer อ่านอย่างเดียว
 *   (pit_tax_brackets/sso_contribution_config, migration 0079)
 *
 * บริบท: เฟส 9 ส่วน AC (docs/06-accounting-features-roadmap.md, หมวด 0.4/0.6) — เลือกแถวที่
 *   `effective_from` ล่าสุดที่ ≤ วันที่ระบุ (asOfDate) — ปกติใช้ `payroll_runs.pay_date` เป็นตัวกำหนด
 *   (วันที่จ่ายจริง ไม่ใช่เดือนที่จ่ายให้ — ตรงกับหลักปฏิบัติจริงที่ยึดวันที่นำส่งเป็นเกณฑ์)
 *
 * ★ 0.6: 2 ตารางนี้ไม่มี tenant_id โดยตั้งใจ (ข้อมูลกฎหมายเดียวกันทุก tenant) — ไม่ต้อง filter
 *   tenant_id ที่นี่เลย (ต่างจากทุก data layer อื่นในระบบ) — ดูคอมเมนต์เต็มใน migration 0079
 * ★ เขียน/แก้ได้เฉพาะ service_role ผ่าน migration ใหม่เมื่อกฎหมายเปลี่ยนจริงเท่านั้น — ไฟล์นี้จึงมีแต่
 *   ฟังก์ชันอ่าน (ไม่มี upsert/insert)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/accounting/queries";

type DB = SupabaseClient;

/** ขั้นภาษีเงินได้บุคคลธรรมดาก้าวหน้า 1 ขั้น (มาตรา 50) ณ วันที่ effective_from หนึ่ง ๆ */
export type PitBracket = {
  bracketOrder: number;
  incomeFrom: number;
  /** null = ไม่มีเพดาน (ขั้นสูงสุด) */
  incomeTo: number | null;
  ratePercent: number;
};

/** อัตรา/ฐานเงินสมทบประกันสังคม (มาตรา 33) ณ ช่วงเวลา effective_from หนึ่ง ๆ */
export type SsoConfig = {
  effectiveFrom: string;
  employeeRatePercent: number;
  employerRatePercent: number;
  wageFloor: number;
  wageCeiling: number;
};

type RawBracketRow = {
  effective_from: string;
  bracket_order: number;
  income_from: number | string;
  income_to: number | string | null;
  rate_percent: number | string;
};

/**
 * ขั้นภาษีก้าวหน้าทั้งหมดของกลุ่ม `effective_from` ล่าสุดที่ ≤ asOfDate (เรียงตาม bracket_order)
 *   คืน null ถ้า asOfDate เก่ากว่าแถวแรกสุดที่มี (ไม่มีข้อมูลเก่ากว่านั้นให้ใช้)
 */
export async function getEffectivePitBrackets(db: DB, asOfDate: string): Promise<PitBracket[] | null> {
  const { data } = await db
    .from("pit_tax_brackets")
    .select("effective_from, bracket_order, income_from, income_to, rate_percent")
    .lte("effective_from", asOfDate)
    .order("effective_from", { ascending: false });
  const rows = (data ?? []) as RawBracketRow[];
  if (rows.length === 0) return null;

  const latest = rows[0].effective_from;
  return rows
    .filter((r) => r.effective_from === latest)
    .map((r) => ({
      bracketOrder: r.bracket_order,
      incomeFrom: round2(Number(r.income_from)),
      incomeTo: r.income_to === null || r.income_to === undefined ? null : round2(Number(r.income_to)),
      ratePercent: Number(r.rate_percent),
    }))
    .sort((a, b) => a.bracketOrder - b.bracketOrder);
}

type RawSsoRow = {
  effective_from: string;
  employee_rate_percent: number | string;
  employer_rate_percent: number | string;
  wage_floor: number | string;
  wage_ceiling: number | string;
};

/** ค่าคอนฟิกประกันสังคม effective_from ล่าสุดที่ ≤ asOfDate — คืน null ถ้าไม่มีแถวที่เก่าพอ */
export async function getEffectiveSsoConfig(db: DB, asOfDate: string): Promise<SsoConfig | null> {
  const { data } = await db
    .from("sso_contribution_config")
    .select("effective_from, employee_rate_percent, employer_rate_percent, wage_floor, wage_ceiling")
    .lte("effective_from", asOfDate)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const r = data as RawSsoRow;
  return {
    effectiveFrom: r.effective_from,
    employeeRatePercent: Number(r.employee_rate_percent),
    employerRatePercent: Number(r.employer_rate_percent),
    wageFloor: round2(Number(r.wage_floor)),
    wageCeiling: round2(Number(r.wage_ceiling)),
  };
}
