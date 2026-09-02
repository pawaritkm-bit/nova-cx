/**
 * Learning map ผังบัญชี (Feature B) — จำว่านักบัญชีลง "คู่ค้า → รหัสบัญชี" ไว้ยังไง แล้วเดาให้บิลใหม่
 *   ★ scope ระดับ tenant · แยก entry_type (ซื้อ/ขาย) · เดา "รหัสที่ใช้บ่อยสุด" (hit_count)
 *   ★ ทุกฟังก์ชัน best-effort: ตาราง line_account_rules ยังไม่ apply (migration 0118) → คืนค่าว่าง/ไม่ทำอะไร (ไม่ throw)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeName, digitsOnly } from "@/lib/line/bill-extract-worker";

type EntryType = "purchase" | "sale";

/** สร้าง key ที่ใช้ match จากคู่ค้า/ยอด — เรียงแม่น→หยาบ: tax → name → amount
 *  ★ 2026-09-02 กติกาผู้ใช้: ชื่อผู้โอน "หรือ" ยอดซ้ำ อย่างใดอย่างหนึ่งก็จับได้
 *    (ยอดซ้ำ = ค่าบริการฟิกราคา เช่น 5,000 = ค่าทำบัญชีรายเดือน) */
function keysOf(counterpartyTaxId: string | null, counterpartyName: string | null, amount?: number | null) {
  const keys: { match_type: "tax" | "name" | "amount"; match_key: string }[] = [];
  const tax = digitsOnly(counterpartyTaxId);
  if (tax.length >= 10) keys.push({ match_type: "tax", match_key: tax });
  const name = normalizeName(counterpartyName);
  if (name.length >= 3) keys.push({ match_type: "name", match_key: name });
  if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
    keys.push({ match_type: "amount", match_key: amount.toFixed(2) });
  }
  return keys;
}

/**
 * บันทึกกฎจากบิลที่นักบัญชีลงบัญชีเอง/แก้ (เรียกหลัง save entry สำเร็จ)
 *   สำหรับแต่ละ line ที่มี account_code + คู่ค้าที่ระบุได้ → upsert (นับ hit_count)
 */
export async function recordAccountRules(
  db: SupabaseClient,
  args: {
    tenantId: string;
    entryType: EntryType;
    counterpartyTaxId: string | null;
    counterpartyName: string | null;
    lines: { accountCode: string | null; accountName?: string | null; amount?: number | null }[];
  }
): Promise<void> {
  const baseKeys = keysOf(args.counterpartyTaxId, args.counterpartyName);
  // ไม่ return ตอน baseKeys ว่าง — บรรทัดที่มียอดยังสร้างคีย์ 'amount' ได้ (กติกา 0128: ชื่อหรือยอด)
  const seen = new Set<string>(); // กันซ้ำ (code เดียวกันหลาย line ในบิลเดียว)
  for (const line of args.lines) {
    const code = (line.accountCode ?? "").trim();
    if (!code) continue;
    // คีย์ยอดของบรรทัดนี้ (ยอดฟิกราคา) — ต่อท้าย tax/name
    const keys = [...baseKeys];
    if (typeof line.amount === "number" && Number.isFinite(line.amount) && line.amount > 0) {
      keys.push({ match_type: "amount", match_key: line.amount.toFixed(2) });
    }
    for (const k of keys) {
      const dedup = `${k.match_type}|${k.match_key}|${code}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      try {
        const { data: existing } = await db
          .from("line_account_rules")
          .select("id, hit_count")
          .eq("tenant_id", args.tenantId)
          .eq("entry_type", args.entryType)
          .eq("match_type", k.match_type)
          .eq("match_key", k.match_key)
          .eq("account_code", code)
          .maybeSingle();
        if (existing && (existing as { id?: string }).id) {
          await db
            .from("line_account_rules")
            .update({
              hit_count: (((existing as { hit_count?: number }).hit_count) ?? 1) + 1,
              account_name: line.accountName ?? null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", (existing as { id: string }).id);
        } else {
          await db.from("line_account_rules").insert({
            tenant_id: args.tenantId,
            entry_type: args.entryType,
            match_type: k.match_type,
            match_key: k.match_key,
            account_code: code,
            account_name: line.accountName ?? null,
          });
        }
      } catch {
        /* ตารางยังไม่ apply → เงียบ */
      }
    }
  }
}

/**
 * เดา account_code จากกฎที่เรียนรู้ (ลอง tax ก่อน name · เอา hit_count สูงสุด)
 *   คืน null = ไม่มีกฎ (ให้นักบัญชีเลือกเอง)
 */
export async function suggestAccountCode(
  db: SupabaseClient,
  tenantId: string,
  entryType: EntryType,
  counterpartyTaxId: string | null,
  counterpartyName: string | null,
  amount?: number | null
): Promise<{ accountCode: string; accountName: string | null } | null> {
  for (const k of keysOf(counterpartyTaxId, counterpartyName, amount)) {
    try {
      const { data } = await db
        .from("line_account_rules")
        .select("account_code, account_name, hit_count")
        .eq("tenant_id", tenantId)
        .eq("entry_type", entryType)
        .eq("match_type", k.match_type)
        .eq("match_key", k.match_key)
        .order("hit_count", { ascending: false })
        .limit(1);
      const row = (data ?? [])[0] as { account_code: string; account_name: string | null } | undefined;
      if (row?.account_code) return { accountCode: row.account_code, accountName: row.account_name ?? null };
    } catch {
      /* ตารางยังไม่ apply → ลอง key ถัดไป/คืน null */
    }
  }
  return null;
}
