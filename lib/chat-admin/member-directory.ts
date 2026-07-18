/**
 * ตัวช่วย 1 — จับคู่สมาชิกข้ามกลุ่ม (review-first) (Phase 5b+)
 *
 * บริบท: นักบัญชี 1 คน (LINE userId เดียว) โผล่หลายร้อยกลุ่ม; บางคน (หัวหน้า/แอดมิน/QA)
 *   เข้า "ทุกกลุ่ม" แต่ไม่ใช่ผู้ดูแลเฉพาะราย → ต้องให้แอดมิน "ตรวจก่อนผูก" ไม่ auto เงียบ
 *
 * A) listMemberDirectory — รวม line_user_id ที่ไม่ซ้ำ "ข้ามทุกกลุ่ม" + displayName(decrypt)
 *      + จำนวนกลุ่มที่อยู่ (groupCount) + สถานะผูก/ยัง + employee ที่ผูก
 *      เรียง groupCount มาก→น้อย (คนอยู่ทุกกลุ่มเด่นบนสุด = สัญญาณหัวหน้า/ทีมกลาง)
 * B) propagateMemberIdentity — ผูกตัวตนของ line_user_id เดียวไปหลายกลุ่ม (ยืนยันก่อน)
 *      + audit_logs สรุป (action chat_member_propagated + จำนวนกลุ่ม)
 *
 * ★ tenant มาจาก session เท่านั้น (caller ส่งมา) · service-role ข้าม RLS → scope ด้วย tenant_id เอง
 * ★ decrypt ชื่อฝั่ง server เฉพาะ admin (reuse lib/crypto/field.ts)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptField, hasEncKey } from "@/lib/crypto/field";
import { MEMBER_KINDS } from "./schema";

type DB = SupabaseClient;

/** ถอดรหัสชื่อแบบ best-effort — คืน null ถ้าไม่มีคีย์/ถอดไม่ได้ */
function safeDecrypt(enc: string | null | undefined): string | null {
  if (!enc || !hasEncKey()) return null;
  try {
    return decryptField(enc);
  } catch {
    return null;
  }
}

/** กลุ่มหนึ่งที่ line_user คนนี้อยู่ (ใช้ทำ preview + เลือกผูกบางกลุ่ม) */
export type MemberGroupRef = {
  chatMemberId: string;
  groupId: string;
  groupName: string | null;
  /** พนักงานที่ผูกกับสมาชิกในกลุ่มนี้ (null = ยังไม่ผูก) */
  employeeId: string | null;
};

/** 1 แถวในหน้า "จับคู่สมาชิก (ภาพรวม)" — 1 line_user_id ข้ามทุกกลุ่ม */
export type MemberDirectoryEntry = {
  lineUserId: string;
  displayName: string | null;
  /** จำนวนกลุ่มที่อยู่ (คนอยู่ทุกกลุ่ม = มาก) */
  groupCount: number;
  /** ผูกพนักงานแล้วอย่างน้อย 1 กลุ่มไหม */
  isLinked: boolean;
  /** พนักงานที่ผูก (ตัวแทน — จากกลุ่มที่ผูกแล้ว) */
  boundEmployeeId: string | null;
  /** บทบาทตัวแทน (จากกลุ่มที่ผูกแล้วก่อน มิฉะนั้นค่าที่พบบ่อยสุด) */
  memberKind: string;
  /** รายชื่อกลุ่มทั้งหมดที่อยู่ (สำหรับ preview + เลือกบางกลุ่ม) */
  groups: MemberGroupRef[];
};

// =====================================================================
// A) LIST — สมาชิกภาพรวมระดับ tenant (distinct line_user_id ข้ามทุกกลุ่ม)
// =====================================================================
export async function listMemberDirectory(
  db: DB,
  tenantId: string
): Promise<MemberDirectoryEntry[]> {
  // 1) ทุก chat_member ใน tenant (ยังไม่ถูกลบ)
  const { data: memberData, error: mErr } = await db
    .from("chat_members")
    .select("id, line_user_id, display_name_enc, member_kind, employee_id, chat_group_id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (mErr) throw new Error(mErr.message);

  type MemberRaw = {
    id: string;
    line_user_id: string;
    display_name_enc: string | null;
    member_kind: string;
    employee_id: string | null;
    chat_group_id: string;
  };
  const members = (memberData ?? []) as unknown as MemberRaw[];
  if (members.length === 0) return [];

  // 2) ชื่อกลุ่ม (decrypt) สำหรับ preview — 1 query
  const groupIds = Array.from(new Set(members.map((m) => m.chat_group_id)));
  const { data: groupData, error: gErr } = await db
    .from("chat_groups")
    .select("id, display_name_enc")
    .eq("tenant_id", tenantId)
    .in("id", groupIds)
    .is("deleted_at", null);
  if (gErr) throw new Error(gErr.message);
  const groupNameById = new Map<string, string | null>();
  for (const g of (groupData ?? []) as { id: string; display_name_enc: string | null }[]) {
    groupNameById.set(g.id, safeDecrypt(g.display_name_enc));
  }

  // 3) จัดกลุ่มตาม line_user_id
  const byUser = new Map<string, MemberRaw[]>();
  for (const m of members) {
    const arr = byUser.get(m.line_user_id);
    if (arr) arr.push(m);
    else byUser.set(m.line_user_id, [m]);
  }

  const entries: MemberDirectoryEntry[] = [];
  for (const [lineUserId, rows] of byUser) {
    // displayName: ชื่อแรกที่ถอดได้
    let displayName: string | null = null;
    for (const r of rows) {
      const n = safeDecrypt(r.display_name_enc);
      if (n) {
        displayName = n;
        break;
      }
    }

    // แถวที่ผูกพนักงานแล้ว (ยืนยันแล้ว) — ใช้เป็นตัวแทน
    const bound = rows.find((r) => r.employee_id);
    const boundEmployeeId = bound?.employee_id ?? null;

    // บทบาทตัวแทน: ถ้ามีแถวผูกแล้ว ใช้ของแถวนั้น มิฉะนั้นค่าที่พบบ่อยสุด
    let memberKind: string;
    if (bound) {
      memberKind = bound.member_kind;
    } else {
      const freq = new Map<string, number>();
      for (const r of rows) freq.set(r.member_kind, (freq.get(r.member_kind) ?? 0) + 1);
      memberKind = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
    }

    const groups: MemberGroupRef[] = rows.map((r) => ({
      chatMemberId: r.id,
      groupId: r.chat_group_id,
      groupName: groupNameById.get(r.chat_group_id) ?? null,
      employeeId: r.employee_id,
    }));

    entries.push({
      lineUserId,
      displayName,
      groupCount: rows.length, // unique(chat_group_id, line_user_id) → 1 แถว = 1 กลุ่ม
      isLinked: !!boundEmployeeId,
      boundEmployeeId,
      memberKind,
      groups,
    });
  }

  // เรียง groupCount มาก→น้อย (คนอยู่ทุกกลุ่มเด่นบนสุด), เท่ากันเรียงชื่อ
  entries.sort(
    (a, b) =>
      b.groupCount - a.groupCount ||
      (a.displayName ?? "").localeCompare(b.displayName ?? "", "th")
  );
  return entries;
}

// =====================================================================
// B) WRITE — propagate ตัวตนของ line_user_id เดียว → หลายกลุ่ม (ยืนยันก่อน)
// =====================================================================
export type PropagateInput = {
  lineUserId: string;
  /** พนักงานที่ผูก (accountant/lead เท่านั้น มิฉะนั้น null) */
  employeeId: string | null;
  memberKind: (typeof MEMBER_KINDS)[number];
  /**
   * เลือกกลุ่มที่จะผูก:
   *   - undefined/[] → โหมด "ทุกกลุ่มที่ยังไม่ผูก" (employee_id IS NULL) — ไม่ทับของที่ผูกแล้ว
   *   - มีค่า        → เฉพาะกลุ่มที่เลือก (chat_group_id IN groupIds)
   */
  groupIds?: string[];
};

/** ตรวจว่าพนักงานอยู่ใน tenant นี้จริง (กัน caller อ้าง id ข้าม tenant) */
async function assertEmployeeInTenant(db: DB, employeeId: string, tenantId: string): Promise<void> {
  const { data, error } = await db
    .from("employees")
    .select("id")
    .eq("id", employeeId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("ไม่พบพนักงานที่เลือก (หรืออยู่นอกสำนักงานของคุณ)");
}

/**
 * ผูกตัวตน (employee + member_kind) ของ line_user_id เดียวไปหลายกลุ่มพร้อมกัน
 *   คืนจำนวนกลุ่มที่อัปเดตจริง (affected) — UI เอาไปแสดง "ผูกแล้ว N กลุ่ม"
 *   ★ เขียน audit_logs สรุปเสมอ (แม้ affected=0 ก็ควรมีร่องรอยว่ามีการกดยืนยัน)
 */
export async function propagateMemberIdentity(
  db: DB,
  tenantId: string,
  input: PropagateInput,
  actorUserId: string | null
): Promise<{ affected: number }> {
  if (!(MEMBER_KINDS as readonly string[]).includes(input.memberKind)) {
    throw new Error("บทบาทสมาชิกไม่ถูกต้อง");
  }
  // accountant/lead ต้องผูกพนักงาน; บทบาทอื่นล้างการผูก (สอดคล้อง setChatMember)
  const employeeId =
    input.memberKind === "accountant" || input.memberKind === "lead" ? input.employeeId : null;
  if ((input.memberKind === "accountant" || input.memberKind === "lead") && !employeeId) {
    throw new Error("บทบาทนักบัญชี/หัวหน้า ต้องเลือกพนักงานที่ผูก");
  }
  if (employeeId) await assertEmployeeInTenant(db, employeeId, tenantId);

  const hasSelection = Array.isArray(input.groupIds) && input.groupIds.length > 0;

  // build update: scope ด้วย tenant + line_user_id เสมอ (กันข้าม tenant)
  let q = db
    .from("chat_members")
    .update({ member_kind: input.memberKind, employee_id: employeeId })
    .eq("tenant_id", tenantId)
    .eq("line_user_id", input.lineUserId)
    .is("deleted_at", null);

  if (hasSelection) {
    q = q.in("chat_group_id", input.groupIds as string[]); // เฉพาะกลุ่มที่เลือก
  } else {
    q = q.is("employee_id", null); // โหมดทั้งหมด: เฉพาะที่ยังไม่ผูก (ไม่ทับของที่ผูกแล้ว)
  }

  const { data, error } = await q.select("id");
  if (error) throw new Error(error.message);
  const affected = (data as unknown[] | null)?.length ?? 0;

  // audit สรุป (append-only) — resource_id เป็น null ได้ (หลายแถว)
  const { error: auditErr } = await db.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: actorUserId,
    action: "chat_member_propagated",
    resource: "chat_member",
    resource_id: null,
    meta: {
      line_user_id: input.lineUserId,
      employee_id: employeeId,
      member_kind: input.memberKind,
      group_count: affected,
      mode: hasSelection ? "selected" : "unmapped",
    },
  });
  if (auditErr) throw new Error(auditErr.message);

  return { affected };
}
