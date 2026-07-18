/**
 * ตัวช่วย 2 — แนะนำลูกค้าจากชื่อกลุ่ม LINE (Phase 5b+)
 *
 * บริบท: แอดมินต้องจับคู่ ~500 กลุ่ม → ลูกค้า ทีละกลุ่มจาก dropdown ยาว ๆ ช้ามาก
 *   → เดาชื่อลูกค้าที่ใกล้เคียงจาก "ชื่อกลุ่ม" (display_name_enc) ให้กดเลือกได้เร็ว
 *
 * สัญญา (contract):
 *   - decrypt chat_groups.display_name_enc ฝั่ง server (best-effort) → ถ้าไม่มีชื่อ/ไม่มีคีย์ = คืน []
 *   - fuzzy match กับ customers(name + business_name, deleted_at is null) ใน tenant เดียวกัน
 *   - normalize ไทยเอง (ตัดช่องว่าง/คำนำหน้า บริษัท/บจก./หจก./ร้าน/คุณ ฯลฯ) — ไม่ใช้ lib นอก
 *   - คืน top ~5 เรียงคะแนนคล้ายมาก→น้อย
 *
 * ★ เป็นแค่ "คำแนะนำ" ไม่ผูกอัตโนมัติ — แอดมินยังต้องกดยืนยัน (ผ่าน mapGroupAction เดิม)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptField, hasEncKey } from "@/lib/crypto/field";

type DB = SupabaseClient;

export type CustomerSuggestion = {
  customerId: string;
  customerName: string;
  businessName: string | null;
  /** คะแนนความคล้าย 0–1 (มาก = คล้ายมาก) */
  score: number;
};

/** ลูกค้าที่ใช้จับคู่ (ชื่อ + ชื่อกิจการ) */
export type CustomerForMatch = {
  id: string;
  name: string;
  business_name: string | null;
};

// คำนำหน้า/คำประกอบชื่อกิจการที่ไม่ช่วยแยกแยะ — ตัดทิ้งก่อนเทียบ (เรียงยาว→สั้น สำคัญ)
const STOP_WORDS = [
  "ห้างหุ้นส่วนจำกัด",
  "ห้างหุ้นส่วนสามัญ",
  "ห้างหุ้นส่วน",
  "บริษัทจำกัด",
  "บริษัท",
  "มหาชน",
  "จำกัด",
  "บมจ",
  "บจก",
  "หจก",
  "หสน",
  "นางสาว",
  "นาง",
  "นาย",
  "คุณ",
  "ร้าน",
  "กลุ่ม",
];

/**
 * normalize ชื่อไทย: lowercase, ตัดวรรคตอน/วงเล็บ, ตัดคำนำหน้ากิจการ, ยุบช่องว่าง
 *   คืนสตริงที่ normalize แล้ว (ยังมีช่องว่างคั่น token)
 */
function normalizeName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  // วรรคตอน/สัญลักษณ์ → ช่องว่าง (รวมจุดใน "บจก." "น.ส.")
  s = s.replace(/[().,\-_/\\'"“”‘’|:;!?@#*+=~`\[\]{}<>]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // ตัด stop words (คำเดี่ยว ๆ ที่ปรากฏที่ใดก็ได้)
  for (const w of STOP_WORDS) {
    // ตัดเมื่อเป็น token หรือ prefix ที่ติดกับคำอื่น (ไทยมักเขียนติดกัน เช่น "บริษัทเอบีซี")
    s = s.split(w).join(" ");
  }
  return s.replace(/\s+/g, " ").trim();
}

/** แตกเป็น token (คำที่คั่นด้วยช่องว่าง) หลัง normalize */
function tokenize(normalized: string): string[] {
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}

/** รวม token เป็นสตริงเดียว (ไม่มีช่องว่าง) เพื่อเทียบ substring — ไทยเขียนติดกันได้ */
function flatten(tokens: string[]): string {
  return tokens.join("");
}

/**
 * คะแนนความคล้ายระหว่างชื่อกลุ่มกับชื่อลูกค้า 1 ชื่อ (0–1)
 *   ผสม: substring (ครอบ/ถูกครอบ) + token overlap (Jaccard) — เขียนเอง
 */
function scoreName(groupTokens: string[], candidate: string): number {
  const candTokens = tokenize(normalizeName(candidate));
  if (groupTokens.length === 0 || candTokens.length === 0) return 0;

  const gFlat = flatten(groupTokens);
  const cFlat = flatten(candTokens);
  if (!gFlat || !cFlat) return 0;

  // 1) substring: เท่ากันเป๊ะ = 1; ครอบกัน = แปรตามสัดส่วนความยาว
  let sub = 0;
  if (gFlat === cFlat) {
    sub = 1;
  } else if (gFlat.includes(cFlat) || cFlat.includes(gFlat)) {
    const shorter = Math.min(gFlat.length, cFlat.length);
    const longer = Math.max(gFlat.length, cFlat.length);
    sub = 0.5 + 0.5 * (shorter / longer);
  }

  // 2) token overlap (Jaccard) — จับกรณีสลับคำ/มีคำเกิน
  const gSet = new Set(groupTokens);
  const cSet = new Set(candTokens);
  let inter = 0;
  for (const t of gSet) if (cSet.has(t)) inter++;
  const union = new Set([...gSet, ...cSet]).size;
  const jaccard = union > 0 ? inter / union : 0;

  return Math.max(sub, jaccard);
}

/**
 * จัดอันดับลูกค้าที่คล้ายชื่อกลุ่มมากที่สุด (pure — ไม่แตะ DB, ทดสอบง่าย)
 *   - ชื่อกลุ่มว่าง/normalize แล้วว่าง → คืน []
 *   - เทียบทั้ง name และ business_name ของลูกค้า เอาคะแนนสูงสุด
 *   - คัดเฉพาะคะแนน >= threshold แล้วเรียงมาก→น้อย เอา top `limit`
 */
export function rankCustomerSuggestions(
  groupName: string | null | undefined,
  customers: CustomerForMatch[],
  limit = 5,
  threshold = 0.25
): CustomerSuggestion[] {
  const groupTokens = tokenize(normalizeName(groupName));
  if (groupTokens.length === 0) return [];

  const scored: CustomerSuggestion[] = [];
  for (const c of customers) {
    const score = Math.max(
      scoreName(groupTokens, c.name),
      scoreName(groupTokens, c.business_name ?? "")
    );
    if (score >= threshold) {
      scored.push({
        customerId: c.id,
        customerName: c.name,
        businessName: c.business_name ?? null,
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.customerName.localeCompare(b.customerName, "th"));
  return scored.slice(0, limit);
}

/**
 * suggestCustomersForGroup — เวอร์ชันที่ดึงข้อมูลจาก DB (server, admin เท่านั้น)
 *   1) decrypt ชื่อกลุ่ม (display_name_enc) — ไม่มีคีย์/ไม่มีชื่อ = คืน []
 *   2) โหลด customers ใน tenant (name + business_name, ยังไม่ถูกลบ)
 *   3) rankCustomerSuggestions
 */
export async function suggestCustomersForGroup(
  db: DB,
  tenantId: string,
  groupId: string
): Promise<CustomerSuggestion[]> {
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
  let groupName: string | null;
  try {
    groupName = decryptField(enc);
  } catch {
    return []; // ถอดไม่ได้ → ไม่แนะนำ (degrade อย่างสุภาพ)
  }
  if (!groupName.trim()) return [];

  // 2) รายชื่อลูกค้าใน tenant
  const { data: custData, error: cErr } = await db
    .from("customers")
    .select("id, name, business_name")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  if (cErr) throw new Error(cErr.message);

  const customers = ((custData ?? []) as CustomerForMatch[]).map((c) => ({
    id: c.id,
    name: c.name,
    business_name: c.business_name ?? null,
  }));

  // 3) จัดอันดับ
  return rankCustomerSuggestions(groupName, customers);
}
