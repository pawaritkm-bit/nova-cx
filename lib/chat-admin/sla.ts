/**
 * Chat-admin — CRUD sla_rules (0034)
 *   rule engine: scope (customer_type/urgency/work_type/team_id) nullable = match ทั้งหมด
 *   priority สูง = ถูกเลือกก่อน · *_minutes = เวลาทำการที่ต้องตอบ/ปิด
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SlaRuleInput } from "./schema";

type DB = SupabaseClient;

function assertAffected(data: unknown[] | null, error: unknown): void {
  if (error) throw new Error((error as { message?: string }).message ?? "update failed");
  if (!data || data.length === 0) throw new Error("ไม่พบเงื่อนไขที่ต้องการแก้ไข");
}

export type SlaRuleRow = {
  id: string;
  name: string;
  customer_type: string | null;
  urgency: string | null;
  work_type: string | null;
  team_id: string | null;
  first_response_minutes: number | null;
  resolution_minutes: number | null;
  priority: number;
  is_active: boolean;
};

export async function listSlaRules(db: DB, tenantId: string): Promise<SlaRuleRow[]> {
  const { data, error } = await db
    .from("sla_rules")
    .select(
      "id, name, customer_type, urgency, work_type, team_id, first_response_minutes, resolution_minutes, priority, is_active"
    )
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as SlaRuleRow[];
}

/** payload ร่วมของ create/update (inject tenant จาก session เท่านั้น) */
function toPayload(tenantId: string, input: SlaRuleInput) {
  return {
    tenant_id: tenantId,
    name: input.name,
    customer_type: input.customer_type,
    urgency: input.urgency,
    work_type: input.work_type,
    team_id: input.team_id ?? null,
    first_response_minutes: input.first_response_minutes,
    resolution_minutes: input.resolution_minutes,
    priority: input.priority,
    is_active: input.is_active,
  };
}

/** ยืนยันว่าทีม (ถ้าระบุ) อยู่ใน tenant นี้ */
async function assertTeamInTenant(db: DB, teamId: string, tenantId: string): Promise<void> {
  const { data, error } = await db
    .from("teams")
    .select("id")
    .eq("id", teamId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("ไม่พบทีมที่เลือก (หรืออยู่นอกสำนักงานของคุณ)");
}

export async function createSlaRule(db: DB, tenantId: string, input: SlaRuleInput): Promise<{ id: string }> {
  if (input.team_id) await assertTeamInTenant(db, input.team_id, tenantId);
  const { data, error } = await db
    .from("sla_rules")
    .insert(toPayload(tenantId, input))
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data as { id: string };
}

export async function updateSlaRule(
  db: DB,
  tenantId: string,
  ruleId: string,
  input: SlaRuleInput
): Promise<void> {
  if (input.team_id) await assertTeamInTenant(db, input.team_id, tenantId);
  const payload = toPayload(tenantId, input);
  // ไม่แก้ tenant_id (scope จาก session)
  const { tenant_id: _omit, ...update } = payload;
  void _omit;
  const { data, error } = await db
    .from("sla_rules")
    .update(update)
    .eq("id", ruleId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .select("id");
  assertAffected(data as unknown[] | null, error);
}

export async function deleteSlaRule(db: DB, tenantId: string, ruleId: string): Promise<void> {
  const { data, error } = await db
    .from("sla_rules")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", ruleId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .select("id");
  assertAffected(data as unknown[] | null, error);
}

export async function setSlaRuleActive(
  db: DB,
  tenantId: string,
  ruleId: string,
  isActive: boolean
): Promise<void> {
  const { data, error } = await db
    .from("sla_rules")
    .update({ is_active: isActive })
    .eq("id", ruleId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .select("id");
  assertAffected(data as unknown[] | null, error);
}
