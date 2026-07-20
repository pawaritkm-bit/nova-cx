/**
 * ตัวช่วย 3 — แนะนำ "นักบัญชีผู้ดูแล" จากชื่อกลุ่ม LINE
 *
 * บริบท: ชื่อกลุ่มลูกค้ามักมี "ชื่อเล่นนักบัญชี" อยู่ในวงเล็บท้าย/หลังเครื่องหมาย /
 *   เช่น "N0003บจก.พงษ์เพอร์ฟอร์แมนซ์ (ฟาง)"
 *        "บจก.นารายณ์พร โกลด์/คุณวิภาวี (นัท)"
 *        "ร้าน โปเต้.../คุณสุภัสสร (ฝน)"
 *   → เดาว่านักบัญชีคนไหนดูแล เพื่อ preselect ใน dropdown (แอดมินยังต้องกดยืนยัน)
 *
 * สัญญา (contract):
 *   - แตกชื่อเล่นที่อยู่ในวงเล็บ ( ) หรือหลังเครื่องหมาย / ออกมาเป็น candidate
 *   - เทียบกับ employees.nickname (และ first_name เผื่อไว้) ของพนักงาน
 *     ที่ employee_type ∈ {accountant, cs} และ is_active + tenant เดียวกัน
 *   - normalize ก่อนเทียบ: lowercase, ตัดอิโมจิ/สัญลักษณ์/ช่องว่าง, ตัดคำนำหน้า (คุณ/นาย/นาง...)
 *   - match แบบ prefix/ตรงกัน (เช่น "ฟาง" ↔ "ฟางข้าว🌻", "นัท" ↔ "นัท", "ฝน" ↔ "ฝน")
 *   - คืน top ~3 เรียงคะแนน — เป็นแค่ "คำแนะนำ" ไม่ผูกอัตโนมัติ
 *
 * ★ pure function (rankAccountantSuggestions) ทดสอบง่าย ไม่แตะ DB
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptField, hasEncKey } from "@/lib/crypto/field";

type DB = SupabaseClient;

export type AccountantSuggestion = {
  employeeId: string;
  /** ชื่อที่ใช้แสดง (nickname ก่อน ถ้าไม่มีใช้ first_name) */
  employeeName: string;
  /** คะแนนความคล้าย 0–1 (มาก = มั่นใจมาก) */
  score: number;
};

/** พนักงานที่ใช้จับคู่ (นักบัญชี/CS) */
export type EmployeeForMatch = {
  id: string;
  nickname: string | null;
  first_name: string;
};

// คำนำหน้าชื่อบุคคล — ตัดทิ้งก่อนเทียบ (เรียงยาว→สั้น สำคัญ เพราะตัดด้วย prefix)
const NAME_TITLES = ["นางสาว", "น.ส.", "นาง", "นาย", "คุณ"];

/**
 * normalize ชื่อเล่น: lowercase, ตัดอิโมจิ/variation selector/ZWJ, ตัดสัญลักษณ์/ช่องว่าง,
 *   ตัดคำนำหน้าชื่อบุคคลนำหน้า — เหลือแต่ตัวอักษร/ตัวเลขติดกัน
 */
function normalizeNick(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  // ตัดอิโมจิ + variation selector (️) + zero-width joiner (‍)
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️‍]/gu, "");
  // เหลือเฉพาะอักษรไทย (฀-๿), a-z, 0-9 — อย่างอื่นทิ้ง (ช่องว่าง/วงเล็บ/จุด ฯลฯ)
  s = s.replace(/[^฀-๿a-z0-9]/g, "");
  // ตัดคำนำหน้าชื่อบุคคล (เช่น "คุณวิภาวี" → "วิภาวี")
  for (const t of NAME_TITLES) {
    const tn = t.replace(/[^฀-๿a-z0-9]/g, "");
    if (tn && s.startsWith(tn) && s.length > tn.length) {
      s = s.slice(tn.length);
      break;
    }
  }
  return s;
}

/**
 * แตก candidate ชื่อเล่นจากชื่อกลุ่ม:
 *   1) ทุกข้อความในวงเล็บ ( ) — ชื่อเล่นนักบัญชีมักอยู่ตรงนี้
 *   2) ทุก segment หลังเครื่องหมาย / (เผื่อชื่อคนอยู่หลัง /)
 * คืน token ที่ normalize แล้ว (ตัดตัวซ้ำ/ว่างออก)
 */
export function extractNicknameCandidates(groupName: string | null | undefined): string[] {
  if (!groupName) return [];
  const chunks: string[] = [];

  // 1) ในวงเล็บ
  const parenRe = /\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = parenRe.exec(groupName)) !== null) {
    chunks.push(m[1]);
  }

  // 2) หลังเครื่องหมาย / (รองรับทั้ง / และ ／ เต็มความกว้าง)
  const bySlash = groupName.split(/[/／]/);
  for (let i = 1; i < bySlash.length; i++) {
    // ตัดส่วนในวงเล็บออกจาก segment กัน candidate ปนกัน เช่น "คุณสุภัสสร (ฝน)" → "คุณสุภัสสร"
    chunks.push(bySlash[i].replace(/\([^)]*\)/g, ""));
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    const n = normalizeNick(c);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * คะแนนระหว่าง candidate (normalize แล้ว) กับชื่อพนักงาน 1 ชื่อ (0–1)
 *   - เท่ากันเป๊ะ = 1
 *   - ตัวหนึ่งเป็น prefix ของอีกตัว = 0.5 + 0.5*(สั้น/ยาว) เช่น "ฟาง"↔"ฟางข้าว"
 *   - candidate สั้นกว่า 2 ตัวอักษร → ไม่นับ (กัน match มั่ว)
 */
function nickScore(candidate: string, employeeName: string): number {
  const e = normalizeNick(employeeName);
  if (!candidate || !e || candidate.length < 2) return 0;
  if (candidate === e) return 1;
  const shorter = Math.min(candidate.length, e.length);
  const longer = Math.max(candidate.length, e.length);
  if (e.startsWith(candidate) || candidate.startsWith(e)) {
    return 0.5 + 0.5 * (shorter / longer);
  }
  return 0;
}

/**
 * จัดอันดับนักบัญชีที่น่าจะดูแลกลุ่มนี้ (pure — ไม่แตะ DB, ทดสอบง่าย)
 *   - ไม่มี candidate ในชื่อกลุ่ม (ไม่มีวงเล็บ/ /) → คืน []
 *   - เทียบทุก candidate × (nickname, first_name) เอาคะแนนสูงสุดต่อพนักงาน
 *   - คัดเฉพาะคะแนน >= threshold แล้วเรียงมาก→น้อย เอา top `limit`
 */
export function rankAccountantSuggestions(
  groupName: string | null | undefined,
  employees: EmployeeForMatch[],
  limit = 3,
  threshold = 0.5
): AccountantSuggestion[] {
  const candidates = extractNicknameCandidates(groupName);
  if (candidates.length === 0) return [];

  const scored: AccountantSuggestion[] = [];
  for (const emp of employees) {
    let best = 0;
    for (const cand of candidates) {
      best = Math.max(best, nickScore(cand, emp.nickname ?? ""), nickScore(cand, emp.first_name));
    }
    if (best >= threshold) {
      scored.push({
        employeeId: emp.id,
        employeeName: emp.nickname || emp.first_name,
        score: best,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.employeeName.localeCompare(b.employeeName, "th"));
  return scored.slice(0, limit);
}

/**
 * suggestAccountantsForGroup — เวอร์ชันดึงข้อมูลจาก DB (server, admin เท่านั้น)
 *   1) decrypt ชื่อกลุ่ม (display_name_enc) — ไม่มีคีย์/ไม่มีชื่อ = คืน []
 *   2) โหลดพนักงาน accountant/cs ที่ active ใน tenant
 *   3) rankAccountantSuggestions
 */
export async function suggestAccountantsForGroup(
  db: DB,
  tenantId: string,
  groupId: string
): Promise<AccountantSuggestion[]> {
  // 1) ชื่อกลุ่ม (ต้องอยู่ใน tenant นี้)
  const { data: groupRow, error: gErr } = await db
    .from("chat_groups")
    .select("display_name_enc")
    .eq("id", groupId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (gErr) throw new Error(gErr.message);

  const enc = (groupRow as { display_name_enc?: string | null } | null)?.display_name_enc ?? null;
  if (!enc || !hasEncKey()) return []; // ไม่มีชื่อ/ไม่มีคีย์ถอด → ไม่แนะนำ
  let groupName: string;
  try {
    groupName = decryptField(enc);
  } catch {
    return []; // ถอดไม่ได้ → ไม่แนะนำ (degrade อย่างสุภาพ)
  }
  if (!groupName.trim()) return [];

  // 2) รายชื่อนักบัญชี/CS ที่ active ใน tenant
  const { data: empData, error: eErr } = await db
    .from("employees")
    .select("id, nickname, first_name")
    .eq("tenant_id", tenantId)
    .in("employee_type", ["accountant", "cs"])
    .eq("is_active", true)
    .is("deleted_at", null);
  if (eErr) throw new Error(eErr.message);

  const employees = ((empData ?? []) as EmployeeForMatch[]).map((e) => ({
    id: e.id,
    nickname: e.nickname ?? null,
    first_name: e.first_name,
  }));

  // 3) จัดอันดับ
  return rankAccountantSuggestions(groupName, employees);
}
