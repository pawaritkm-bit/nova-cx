/**
 * Chat-admin mapping service — จับคู่ "กลุ่ม LINE → ลูกค้า" และ "สมาชิก → พนักงาน"
 *   (Phase 5b · flow ที่ Phase 1 note ว่าต้องทำ — LINE ไม่บอกว่าใครเป็นนักบัญชี)
 *
 * สัญญา (contract):
 *   - รับ db (service-role client เพื่อข้าม RLS) + tenantId (จาก session เท่านั้น) + data
 *   - decrypt ชื่อกลุ่ม/สมาชิก (display_name_enc) ฝั่ง server — best-effort (ไม่มีคีย์ = null)
 *   - เขียน chat_groups.customer_id (source of truth) + customer_group_mapping (audit/history)
 *   - เขียน chat_members.employee_id/member_kind + audit_logs (append-only)
 *   - assertAffected กัน id ผิด/ข้าม tenant คืน success เท็จ (service-role ไม่โดน RLS)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptField, hasEncKey } from "@/lib/crypto/field";
import type { MapGroupInput, SetMemberInput } from "./schema";

type DB = SupabaseClient;

/** ยืนยันว่า mutation แตะจริง ≥1 แถว (service-role ข้าม RLS จึงต้องเช็คเอง) */
function assertAffected(data: unknown[] | null, error: unknown): void {
  if (error) throw new Error((error as { message?: string }).message ?? "update failed");
  if (!data || data.length === 0) throw new Error("ไม่พบรายการที่ต้องการแก้ไข");
}

/** ถอดรหัสชื่อแบบ best-effort — คืน null ถ้าไม่มีคีย์/ถอดไม่ได้ (degrade อย่างสุภาพ) */
function safeDecrypt(enc: string | null | undefined): string | null {
  if (!enc || !hasEncKey()) return null;
  try {
    return decryptField(enc);
  } catch {
    return null; // token เพี้ยน/คีย์ไม่ตรง — ไม่ให้ทั้งหน้าใช้ไม่ได้
  }
}

/** ตรวจว่า record อยู่ใน tenant นี้จริง (กัน caller อ้าง id ข้าม tenant) */
async function assertInTenant(
  db: DB,
  table: "customers" | "employees" | "chat_groups",
  id: string,
  tenantId: string,
  label: string
): Promise<void> {
  const { data, error } = await db
    .from(table)
    .select("id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`ไม่พบ${label}ที่เลือก (หรืออยู่นอกสำนักงานของคุณ)`);
}

// =====================================================================
// LIST — กลุ่ม LINE (decrypt ชื่อ) + ลูกค้าที่จับคู่ + จำนวนสมาชิก
// =====================================================================
export type ChatGroupRow = {
  id: string;
  groupName: string | null;
  customerId: string | null;
  customerName: string | null;
  memberCount: number;
  joinedAt: string | null;
  isActive: boolean;
};

export async function listChatGroups(db: DB, tenantId: string): Promise<ChatGroupRow[]> {
  const { data, error } = await db
    .from("chat_groups")
    .select("id, display_name_enc, customer_id, joined_at, is_active, customers(name)")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("joined_at", { ascending: false });
  if (error) throw new Error(error.message);

  type Raw = {
    id: string;
    display_name_enc: string | null;
    customer_id: string | null;
    joined_at: string | null;
    is_active: boolean;
    customers: { name?: string } | { name?: string }[] | null;
  };
  const rows = (data ?? []) as unknown as Raw[];
  if (rows.length === 0) return [];

  // นับสมาชิกต่อกลุ่ม (1 query)
  const groupIds = rows.map((r) => r.id);
  const { data: memberData } = await db
    .from("chat_members")
    .select("chat_group_id")
    .eq("tenant_id", tenantId)
    .in("chat_group_id", groupIds)
    .is("deleted_at", null);
  const countByGroup = new Map<string, number>();
  for (const m of (memberData ?? []) as { chat_group_id: string }[]) {
    countByGroup.set(m.chat_group_id, (countByGroup.get(m.chat_group_id) ?? 0) + 1);
  }

  return rows.map((r) => {
    const cust = Array.isArray(r.customers) ? r.customers[0] : r.customers;
    return {
      id: r.id,
      groupName: safeDecrypt(r.display_name_enc),
      customerId: r.customer_id,
      customerName: cust?.name ?? null,
      memberCount: countByGroup.get(r.id) ?? 0,
      joinedAt: r.joined_at,
      isActive: r.is_active,
    };
  });
}

// =====================================================================
// LIST — สมาชิกในกลุ่ม (decrypt ชื่อ) + พนักงานที่ผูก
// =====================================================================
export type ChatMemberRow = {
  id: string;
  memberName: string | null;
  memberKind: string;
  employeeId: string | null;
  employeeName: string | null;
};

export async function listChatMembers(
  db: DB,
  tenantId: string,
  chatGroupId: string
): Promise<ChatMemberRow[]> {
  const { data, error } = await db
    .from("chat_members")
    .select("id, display_name_enc, member_kind, employee_id, employees(first_name, nickname)")
    .eq("tenant_id", tenantId)
    .eq("chat_group_id", chatGroupId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  type Raw = {
    id: string;
    display_name_enc: string | null;
    member_kind: string;
    employee_id: string | null;
    employees: { first_name?: string; nickname?: string | null } | { first_name?: string; nickname?: string | null }[] | null;
  };
  return ((data ?? []) as unknown as Raw[]).map((r) => {
    const emp = Array.isArray(r.employees) ? r.employees[0] : r.employees;
    return {
      id: r.id,
      memberName: safeDecrypt(r.display_name_enc),
      memberKind: r.member_kind,
      employeeId: r.employee_id,
      employeeName: emp ? emp.nickname || emp.first_name || null : null,
    };
  });
}

// =====================================================================
// WRITE — จับคู่กลุ่ม → ลูกค้า (chat_groups.customer_id + audit history)
// =====================================================================
export async function mapGroupToCustomer(
  db: DB,
  tenantId: string,
  input: MapGroupInput,
  mappedBy: string | null
): Promise<void> {
  // ยืนยันกลุ่มอยู่ใน tenant + ลูกค้า (ถ้าจับคู่) อยู่ใน tenant
  await assertInTenant(db, "chat_groups", input.chat_group_id, tenantId, "กลุ่ม");
  if (input.customer_id) {
    await assertInTenant(db, "customers", input.customer_id, tenantId, "ลูกค้า");
  }

  // 1) set source of truth
  const { data, error } = await db
    .from("chat_groups")
    .update({ customer_id: input.customer_id })
    .eq("id", input.chat_group_id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .select("id");
  assertAffected(data as unknown[] | null, error);

  // 2) audit/history — เขียนเฉพาะเมื่อ "จับคู่" (มี customer_id); ยกเลิกจับคู่ไม่ต้องบันทึกซ้ำ
  if (input.customer_id) {
    const { error: mapErr } = await db.from("customer_group_mapping").insert({
      tenant_id: tenantId,
      chat_group_id: input.chat_group_id,
      customer_id: input.customer_id,
      mapped_by: mappedBy,
      note: "จับคู่ผ่านหน้าตั้งค่า (admin)",
    });
    if (mapErr) throw new Error(mapErr.message);
  }
}

// =====================================================================
// WRITE — จับคู่สมาชิก → พนักงาน / ระบุบทบาท (+ audit_logs)
// =====================================================================
export async function setChatMember(
  db: DB,
  tenantId: string,
  input: SetMemberInput,
  actorUserId: string | null
): Promise<void> {
  // ถ้าผูกพนักงาน → พนักงานต้องอยู่ใน tenant นี้
  const employeeId =
    input.member_kind === "accountant" || input.member_kind === "lead"
      ? input.employee_id
      : null; // บทบาทอื่นล้างการผูกพนักงาน (สอดคล้อง schema refine)
  if (employeeId) {
    await assertInTenant(db, "employees", employeeId, tenantId, "พนักงาน");
  }

  const { data, error } = await db
    .from("chat_members")
    .update({ member_kind: input.member_kind, employee_id: employeeId })
    .eq("id", input.chat_member_id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .select("id");
  assertAffected(data as unknown[] | null, error);

  // audit (append-only) — บันทึกการจับคู่ตัวตนสมาชิก
  const { error: auditErr } = await db.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: actorUserId,
    action: "chat_member_mapped",
    resource: "chat_member",
    resource_id: input.chat_member_id,
    meta: { member_kind: input.member_kind, employee_id: employeeId },
  });
  if (auditErr) throw new Error(auditErr.message);
}
