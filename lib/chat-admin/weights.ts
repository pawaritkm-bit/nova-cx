/**
 * Chat-admin — อ่าน/บันทึกน้ำหนักคะแนน 8 มิติ (evaluation_weights, 0035)
 *   ★ 1 tenant มี "ชุด active" ได้ชุดเดียว (partial unique index) + CHECK รวม = 100
 *   บันทึก = ปิดชุดเดิม (is_active=false) แล้ว insert ชุดใหม่ active (เก็บ history)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { DIMENSIONS, DEFAULT_WEIGHTS, validateWeights, type Weights } from "@/lib/evaluation/weights";

type DB = SupabaseClient;

/** อ่านชุดน้ำหนัก active ปัจจุบัน — ไม่มี = DEFAULT_WEIGHTS (degrade) */
export async function getActiveWeights(db: DB, tenantId: string): Promise<Weights> {
  const { data, error } = await db
    .from("evaluation_weights")
    .select("weights")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const raw = (data as { weights?: Record<string, unknown> } | null)?.weights;
  if (!raw) return { ...DEFAULT_WEIGHTS };

  const out = {} as Weights;
  for (const d of DIMENSIONS) {
    const n = Number(raw[d]);
    out[d] = Number.isFinite(n) ? n : DEFAULT_WEIGHTS[d];
  }
  return out;
}

/**
 * บันทึกชุดน้ำหนักใหม่ (รวมต้อง = 100)
 *   1) validate รวม = 100 (กัน CHECK constraint reject แบบ error ดิบ)
 *   2) ปิดชุด active เดิม (is_active=false) — กันชน partial unique
 *   3) insert ชุดใหม่ active
 */
export async function saveWeights(db: DB, tenantId: string, weights: Weights): Promise<void> {
  if (!validateWeights(weights)) {
    throw new Error("น้ำหนักรวมต้องเท่ากับ 100 พอดี");
  }

  // ปิดชุด active เดิม (best-effort: อาจยังไม่มี → 0 แถวไม่ error)
  const { error: closeErr } = await db
    .from("evaluation_weights")
    .update({ is_active: false })
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null);
  if (closeErr) throw new Error(closeErr.message);

  // สร้าง jsonb map ตามลำดับ DIMENSIONS
  const weightMap: Record<string, number> = {};
  for (const d of DIMENSIONS) weightMap[d] = weights[d];

  const { error: insErr } = await db.from("evaluation_weights").insert({
    tenant_id: tenantId,
    name: "custom",
    weights: weightMap,
    is_active: true,
  });
  if (insErr) {
    // CHECK constraint (รวม != 100) หรือ unique ชน — แจ้งสุภาพ
    if ((insErr as { code?: string }).code === "23514") {
      throw new Error("น้ำหนักรวมต้องเท่ากับ 100 พอดี");
    }
    throw new Error(insErr.message);
  }
}
