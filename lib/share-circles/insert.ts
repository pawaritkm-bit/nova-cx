import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedShareCircleEntry } from "@/lib/ai/share-circle";
import {
  listShareCircleEntries,
  buildDedupKeySet,
  shareCircleDedupKey,
} from "@/lib/share-circles/queries";

/**
 * เขียนวงที่ AI แยกได้ ลง share_circle_entries (source='ai') พร้อม dedup ระดับ "วง"
 *   ★ กันบันทึกรายได้/ภาษีซ้ำ: เทียบกับ entry เดิมของลูกค้า+เดือนนั้น (ที่ยังไม่ลบ)
 *     วง "ซ้ำ" = ชื่อ(normalize) ตรง + ยอดหลักตรง (G+H+I+J+ต้น) → ข้าม ไม่ insert
 *   ★ dedup ภายใน batch เองด้วย (วางลิสต์ที่มีวงซ้ำในตัว)
 *   ★ ใช้ร่วมทั้ง วางคำ / อัปรูป / อ่านจากไลน์ (แหล่งเดียวกัน สูตร dedup เดียวกัน)
 *   @returns { added, skipped } — สรุปภาษีจะนับเฉพาะที่ insert จริง (added)
 */
export async function insertParsedCirclesDedup(
  db: SupabaseClient,
  tenantId: string,
  customerId: string,
  month: string,
  circles: ParsedShareCircleEntry[],
  sourceRef: string
): Promise<{ added: number; skipped: number }> {
  if (circles.length === 0) return { added: 0, skipped: 0 };

  // 1) โหลด entry เดิมของลูกค้า+เดือนนี้ (ยังไม่ลบ) → สร้าง set คีย์ dedup
  let existing: Awaited<ReturnType<typeof listShareCircleEntries>> = [];
  try {
    existing = await listShareCircleEntries(db, { tenantId, customerId, month });
  } catch {
    existing = []; // table ยังไม่ apply/พัง → ปล่อยให้ insert ไปเจอ error เอง (best-effort)
  }
  const seen = buildDedupKeySet(existing);

  // 2) partition: ข้ามวงซ้ำ (กับของเดิม + กันซ้ำภายใน batch)
  const toInsert: ParsedShareCircleEntry[] = [];
  let skipped = 0;
  for (const c of circles) {
    const key = shareCircleDedupKey({
      circleName: c.circle_name,
      taoIncome: c.tao_income,
      mgmtFee: c.mgmt_fee,
      operationFee: c.operation_fee,
      interestIncome: c.interest_income,
      principalPerHead: c.principal_per_head,
    });
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    toInsert.push(c);
  }
  if (toInsert.length === 0) return { added: 0, skipped };

  // 3) insert เฉพาะวงใหม่ (source='ai')
  const rows = toInsert.map((c) => ({
    tenant_id: tenantId,
    customer_id: customerId,
    period_month: month,
    circle_name: c.circle_name,
    round_note: c.round_note,
    member_count: c.member_count,
    principal_per_head: c.principal_per_head,
    tao_income: c.tao_income,
    mgmt_fee: c.mgmt_fee,
    operation_fee: c.operation_fee,
    interest_income: c.interest_income,
    expense: c.expense,
    source: "ai",
    source_ref: sourceRef,
    // ★ PDPA: เก็บแค่ชื่อวง (สรุปย่อ) ไม่ใช่เนื้อดิบ
    source_text: c.circle_name,
    status: "active",
  }));
  const { error } = await db.from("share_circle_entries").insert(rows);
  if (error) return { added: 0, skipped };
  return { added: rows.length, skipped };
}

/**
 * เช็ค "input ซ้ำเป๊ะ" ระดับ source_ref (วางคำ/รูปเดิม) — คืน true ถ้าเคยประมวลผลแล้ว
 *   ★ ใช้ก่อนยิง AI (ประหยัด + กันซ้ำ) · เทียบ source_ref ของ entry ที่ยังไม่ลบ
 */
export async function sourceRefAlreadyUsed(
  db: SupabaseClient,
  tenantId: string,
  customerId: string,
  month: string,
  sourceRef: string
): Promise<boolean> {
  try {
    const { data } = await db
      .from("share_circle_entries")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .eq("period_month", month)
      .eq("source_ref", sourceRef)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}
