import type { SupabaseClient } from "@supabase/supabase-js";

type Snapshot = {
  entry: Record<string, unknown>;
  lines: Record<string, unknown>[];
};

async function loadSnapshot(
  db: SupabaseClient,
  tenantId: string,
  entryId: string
): Promise<Snapshot | null> {
  const { data: entry, error: entryError } = await db
    .from("bill_entries")
    .select("entry_type,doc_date,doc_no,counterparty_name,counterparty_tax_id,seller_name,seller_tax_id,buyer_name,buyer_tax_id,wht_form,payment_method,due_date,currency,fx_rate,source,ai_confidence")
    .eq("tenant_id", tenantId)
    .eq("id", entryId)
    .maybeSingle();
  if (entryError || !entry) return null;

  const { data: lines, error: linesError } = await db
    .from("bill_entry_lines")
    .select("line_no,vat_type,description,account_code,account_name,amount,vat_amount,wht_rate,wht_amount,ai_filled,ai_low_confidence")
    .eq("tenant_id", tenantId)
    .eq("entry_id", entryId)
    .order("line_no", { ascending: true });
  if (linesError) return null;
  return { entry: entry as Record<string, unknown>, lines: (lines ?? []) as Record<string, unknown>[] };
}

/** เก็บ baseline เฉพาะครั้งแรกที่คนเปิดแก้ร่าง AI — ไม่เรียก AI เพิ่ม */
export async function captureAiReviewBaseline(
  db: SupabaseClient,
  tenantId: string,
  entryId: string
): Promise<Snapshot | null> {
  try {
    const { data: existing, error } = await db
      .from("bill_ai_review_audits")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("entry_id", entryId)
      .limit(1);
    // migration ยังไม่ถูก apply → degrade เงียบ ไม่กระทบการบันทึก
    if (error || (existing?.length ?? 0) > 0) return null;
    const snapshot = await loadSnapshot(db, tenantId, entryId);
    return snapshot?.entry.source === "ai" ? snapshot : null;
  } catch {
    return null;
  }
}

/** บันทึก before/after เพื่อคำนวณ accuracy ภายหลัง (DB อย่างเดียว ไม่มีค่า token) */
export async function recordAiReviewResult(
  db: SupabaseClient,
  tenantId: string,
  entryId: string,
  baseline: Snapshot | null
): Promise<void> {
  if (!baseline) return;
  try {
    const reviewed = await loadSnapshot(db, tenantId, entryId);
    if (!reviewed) return;
    await db.from("bill_ai_review_audits").insert({
      tenant_id: tenantId,
      entry_id: entryId,
      ai_snapshot: baseline,
      reviewed_snapshot: reviewed,
    });
  } catch {
    // analytics ห้ามทำให้การบันทึกบัญชีล้ม
  }
}
