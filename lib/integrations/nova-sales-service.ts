import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CustomerUpsertPayload,
  DealStatusPayload,
} from "./nova-sales";
import {
  dealCyclePeriod,
  dealInvitationIdempotencyKey,
  dealStatusToSurveyType,
} from "./nova-sales";
import { getActiveVersionByType } from "@/lib/survey/service";
import { generateInvitationToken } from "@/lib/survey/token";

/**
 * DB logic ของ NOVA Sales Integration (ใช้ service-role client จาก route)
 *   - upsert customer/lead/opportunity แบบ idempotent (external_ref — 0019) + จับ 23505 กัน race
 *   - ยืนยัน cross-tenant: ทุก id ที่รับจาก payload ต้องอยู่ tenant เดียวกัน + มีจริง (Reviewer 🔴#2)
 *   - เขียน sales_status_history เมื่อสถานะเปลี่ยน
 *   - Won (C) → enqueue survey_invitation + push OA Sale เหมือนเดิม (ลูกค้ามักแอด OA)
 *   - Lost (D) → enqueue survey_invitation แต่ "ไม่ push OA" (prospect มักไม่ได้แอด OA)
 *     → คืน token/survey_url ให้ NOVA Sales/เซล ส่งลิงก์ให้ prospect เองผ่านช่องที่คุยอยู่
 */

type DB = SupabaseClient;

/** error สำหรับ input ที่ไม่ถูกต้อง (route แปลงเป็น 400 — ไม่ใช่ 500) */
export class IntegrationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationValidationError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: string }).code === "23505"
  );
}

// --------------------------------------------------------------------------
// cross-tenant guards (query ยืนยันก่อนเขียน)
// --------------------------------------------------------------------------

/** ยืนยันลูกค้าอยู่ tenant นี้ + ไม่ soft-deleted (คืน id) */
async function assertCustomerInTenant(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<string> {
  const { data } = await db
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) {
    throw new IntegrationValidationError(
      "ไม่พบลูกค้าใน tenant นี้ (customer_id ไม่ถูกต้อง)"
    );
  }
  return (data as { id: string }).id;
}

/** ยืนยันพนักงานอยู่ tenant นี้ + ไม่ soft-deleted (คืน id + ชื่อสำหรับ enrich snapshot) */
async function assertEmployeeInTenant(
  db: DB,
  tenantId: string,
  employeeId: string,
  field: string
): Promise<{ id: string; name: string | null }> {
  const { data } = await db
    .from("employees")
    .select("id, first_name, nickname")
    .eq("id", employeeId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) {
    throw new IntegrationValidationError(
      `ไม่พบพนักงานใน tenant นี้ (${field} ไม่ถูกต้อง)`
    );
  }
  const row = data as { id: string; first_name?: string; nickname?: string };
  return { id: row.id, name: row.nickname || row.first_name || null };
}

// --------------------------------------------------------------------------
// resolve sales employee (uuid ตรง / ชื่อจาก roster NOVA Sales)
// --------------------------------------------------------------------------

/** สถานะการ map ชื่อเซล → employee_id (ส่งกลับให้ NOVA Sales debug ว่าชื่อตรงไหม) */
export type SalesEmployeeResolution = {
  /** employee_id ที่ resolve ได้ (null = ประเมินแบบไม่ระบุตัวเซล) */
  employeeId: string | null;
  /** ชื่อพนักงาน ณ ตอนนั้น (best-effort สำหรับ snapshot) */
  name: string | null;
  reason: "matched" | "not_found" | "ambiguous";
};

/** normalize ชื่อสำหรับเทียบ: trim + ยุบช่องว่าง + lowercase */
function normalizeName(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
}

/**
 * resolve เซลผู้ถูกประเมินจาก payload:
 *   - มี sales_employee_id (uuid) → ใช้ตรง (คง cross-tenant guard เดิม)
 *   - ไม่งั้นมี name → match best-effort กับ employees ของ tenant (active, ไม่ soft-deleted)
 *     เทียบ nickname หรือ first_name (trim, ยุบช่องว่าง, case-insensitive)
 *       · เจอพอดี 1 คน → ใช้ id นั้น
 *       · เจอ 0 คน → not_found (คืน null — ประเมินแบบไม่ระบุตัว ไม่ error)
 *       · เจอ >1 คน (กำกวม) → prefer พนักงานชนิด 'sales'; ถ้ายัง >1 → ambiguous (null)
 */
export async function resolveSalesEmployeeId(
  db: DB,
  tenantId: string,
  opts: { id?: string | null; name?: string | null }
): Promise<SalesEmployeeResolution> {
  // uuid ภายใน → ใช้ตรง (assert ว่าอยู่ tenant เดียวกัน)
  if (opts.id) {
    const emp = await assertEmployeeInTenant(db, tenantId, opts.id, "sales_employee_id");
    return { employeeId: emp.id, name: emp.name, reason: "matched" };
  }

  const target = normalizeName(opts.name);
  if (!target) {
    return { employeeId: null, name: null, reason: "not_found" };
  }

  const { data } = await db
    .from("employees")
    .select("id, first_name, nickname, employee_type")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null);

  const rows = (Array.isArray(data) ? data : []) as {
    id: string;
    first_name?: string;
    nickname?: string;
    employee_type?: string;
  }[];

  const matches = rows.filter(
    (r) =>
      normalizeName(r.nickname) === target ||
      normalizeName(r.first_name) === target
  );

  const pick = (r: (typeof matches)[number]): SalesEmployeeResolution => ({
    employeeId: r.id,
    name: r.nickname || r.first_name || null,
    reason: "matched",
  });

  if (matches.length === 1) return pick(matches[0]);
  if (matches.length === 0) {
    return { employeeId: null, name: null, reason: "not_found" };
  }

  // ชื่อซ้ำหลายคน → prefer ชนิด 'sales' ก่อน (ถ้าแยกได้พอดี 1 คน)
  const salesMatches = matches.filter((r) => r.employee_type === "sales");
  if (salesMatches.length === 1) return pick(salesMatches[0]);

  // ยังกำกวม → ไม่เดา คืน null (ประเมินแบบไม่ระบุตัว)
  return { employeeId: null, name: null, reason: "ambiguous" };
}

// --------------------------------------------------------------------------
// customer / lead
// --------------------------------------------------------------------------

/**
 * upsert ลูกค้าตาม external_ref (idempotent + จับ 23505) → คืน customer id
 *
 * หลักการรหัสลูกค้า (requirement ผู้ใช้ 2026-07-22): NOVA Sales เป็นเจ้าของรหัส —
 * ลูกค้าที่ NOVA Sales ดันเข้ามาต้องได้ customer_code จริงตาม payload เสมอ (ไม่ bump ตัวที่เข้ามา)
 */
export async function upsertCustomer(
  db: DB,
  payload: CustomerUpsertPayload
): Promise<{ id: string; created: boolean }> {
  const externalRef = payload.external_customer_id ?? null;
  const customerCode = payload.customer_code ?? null;

  const updateFields = {
    name: payload.name,
    business_name: payload.business_name ?? null,
    service_start_date: payload.service_start_date ?? null,
    ...(payload.status ? { status: payload.status } : {}),
    ...(customerCode ? { customer_code: customerCode } : {}),
  };

  // fast path: หาโดย external_ref → ลูกค้าเดิม → update ตาม payload (รวม customer_code จริง)
  if (externalRef) {
    const existingId = await findCustomerByExternalRef(db, payload.tenant_id, externalRef);
    if (existingId) {
      await db.from("customers").update(updateFields).eq("id", existingId);
      return { id: existingId, created: false };
    }
  }

  // insert ใหม่ — NOVA Sales เป็นเจ้าของรหัส: ต้องได้ customer_code จริงตาม payload เสมอ (ไม่ bump)
  //   ถ้า insert ชน 23505:
  //     (1) external_ref ชนกับ row ที่ยัง active = race → ลูกค้าเดียวกัน → re-select แล้ว update (idempotent)
  //     (2) customer_code ชนกับลูกค้า active คนอื่น → ให้ "ตัวที่ถือรหัสอยู่เดิม" สละรหัส (code→null)
  //         แล้ว retry insert ด้วย customer_code จริง → NOVA Sales ชนะเสมอ + push ไม่ล้ม
  //   (หลัง 0042 เป็น partial unique: soft-deleted/รหัส null ไม่ชนแล้ว เหลือแค่เคส active-active ที่หายาก)
  const base = {
    tenant_id: payload.tenant_id,
    external_ref: externalRef,
    name: payload.name,
    business_name: payload.business_name ?? null,
    service_start_date: payload.service_start_date ?? null,
    status: payload.status ?? "active",
    customer_code: customerCode,
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await db
      .from("customers")
      .insert(base)
      .select("id")
      .single();

    if (!error) {
      return { id: (data as { id: string }).id, created: true };
    }
    if (!isUniqueViolation(error)) {
      throw new Error(error.message);
    }
    // (1) external_ref ชน = ลูกค้าเดียวกัน (race) → update ตาม payload
    if (externalRef) {
      const existingId = await findCustomerByExternalRef(db, payload.tenant_id, externalRef);
      if (existingId) {
        await db.from("customers").update(updateFields).eq("id", existingId);
        return { id: existingId, created: false };
      }
    }
    // (2) customer_code ชน → ปลดรหัสจากลูกค้าเดิมให้ NOVA Sales แล้ว retry
    //     ไม่มี code แต่ยังชน = ชนอย่างอื่นที่หาสาเหตุไม่ได้ → throw กันวนไม่จบ
    if (!customerCode) {
      throw new Error(error.message);
    }
    const holderId = await findActiveCustomerCodeHolder(
      db,
      payload.tenant_id,
      customerCode,
      externalRef
    );
    if (!holderId) {
      // ชน code แต่หาเจ้าของ active ไม่เจอ (race แปลก ๆ) → throw กันวนไม่จบ
      throw new Error(error.message);
    }
    // ให้ตัวที่ถือรหัสเดิม "สละรหัส" (customer_code = null) — filter tenant_id กัน cross-tenant
    await db
      .from("customers")
      .update({ customer_code: null })
      .eq("id", holderId)
      .eq("tenant_id", payload.tenant_id);
    // วนไป retry insert ด้วย customer_code จริง
  }
  throw new Error(
    "ไม่สามารถกำหนด customer_code ให้ลูกค้าที่ NOVA Sales ส่งเข้ามาได้ (ชนรหัสเกินจำนวนครั้งที่ retry)"
  );
}

/**
 * หา "ตัวที่ถือ customer_code นี้อยู่" ใน tenant เดียวกัน (active, ต่าง external_ref)
 * เพื่อให้มันสละรหัสให้ลูกค้าที่ NOVA Sales ดันเข้ามา
 *   - filter tenant_id + deleted_at is null → เจอเฉพาะเจ้าของรหัสที่ยังใช้งาน
 *   - ถ้า row นั้นเป็น external_ref เดียวกับที่เข้ามา (ลูกค้าเดียวกัน) → ไม่ปลด (คืน null)
 *     ปล่อยให้ path external_ref จัดการเป็น update แทน
 */
async function findActiveCustomerCodeHolder(
  db: DB,
  tenantId: string,
  customerCode: string,
  incomingExternalRef: string | null
): Promise<string | null> {
  const { data } = await db
    .from("customers")
    .select("id, external_ref")
    .eq("tenant_id", tenantId)
    .eq("customer_code", customerCode)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return null;
  const row = data as { id: string; external_ref: string | null };
  if (incomingExternalRef !== null && row.external_ref === incomingExternalRef) {
    return null;
  }
  return row.id;
}

async function findCustomerByExternalRef(
  db: DB,
  tenantId: string,
  externalRef: string
): Promise<string | null> {
  const { data } = await db
    .from("customers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("external_ref", externalRef)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? (data as { id: string }).id : null;
}

/**
 * soft-delete ลูกค้าตาม external_ref (delete-sync จาก NOVA Sales) — idempotent
 *   - หาลูกค้าด้วย external_ref + tenant (เฉพาะที่ยังไม่ถูกลบ)
 *     → ไม่เจอ (ไม่มีจริง / ลบไปแล้ว / คนละ tenant) = no-op (deleted:false) ไม่ error
 *   - เจอ → set deleted_at=now(), status='cancelled' (ค่าที่ customers.status enum รับ)
 *   - เคลียร์ chat_groups.customer_id (กลุ่ม/ห้องของลูกค้านั้นใน tenant) → null
 *     คง responsible_employee_id ไว้ (ผู้ดูแลที่แอดมินกำหนดไม่เกี่ยวกับการลบลูกค้า)
 *   - ไม่แตะ customer_assignments (การมอบหมายเก็บไว้เป็นประวัติ)
 *   - filter tenant_id ทุก query → กัน cross-tenant (ลบข้าม tenant ไม่ได้)
 */
export async function softDeleteCustomerByExternalRef(
  db: DB,
  tenantId: string,
  externalRef: string
): Promise<{ deleted: boolean; customerId: string | null }> {
  const customerId = await findCustomerByExternalRef(db, tenantId, externalRef);
  if (!customerId) {
    // ไม่เจอลูกค้าที่ยัง active ใน tenant นี้ → idempotent no-op
    return { deleted: false, customerId: null };
  }

  const now = new Date().toISOString();

  // soft-delete ตัวลูกค้า (คง external_ref ไว้เพื่อ idempotency ของการยิงลบซ้ำ)
  await db
    .from("customers")
    .update({ deleted_at: now, status: "cancelled" })
    .eq("id", customerId)
    .eq("tenant_id", tenantId);

  // เคลียร์การจับคู่กลุ่ม/ห้องแชท → customer_id = null (คง responsible_employee_id)
  await db
    .from("chat_groups")
    .update({ customer_id: null })
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId);

  return { deleted: true, customerId };
}

/** upsert lead ตาม external_ref (idempotent + จับ 23505) → คืน lead id หรือ null */
export async function upsertLead(
  db: DB,
  tenantId: string,
  lead: NonNullable<CustomerUpsertPayload["lead"]>,
  customerId: string | null
): Promise<string | null> {
  if (lead.owner_employee_id) {
    await assertEmployeeInTenant(db, tenantId, lead.owner_employee_id, "owner_employee_id");
  }

  const externalRef = lead.external_lead_id ?? null;
  const updateFields = {
    name: lead.name ?? undefined,
    source: lead.source ?? undefined,
    owner_employee_id: lead.owner_employee_id ?? undefined,
    customer_id: customerId ?? undefined,
  };

  if (externalRef) {
    const existingId = await findLeadByExternalRef(db, tenantId, externalRef);
    if (existingId) {
      await db.from("sales_leads").update(updateFields).eq("id", existingId);
      return existingId;
    }
  }

  const { data, error } = await db
    .from("sales_leads")
    .insert({
      tenant_id: tenantId,
      external_ref: externalRef,
      customer_id: customerId,
      owner_employee_id: lead.owner_employee_id ?? null,
      name: lead.name ?? "(ไม่ระบุ)",
      source: lead.source ?? null,
      status: "new",
    })
    .select("id")
    .single();

  if (error) {
    if (isUniqueViolation(error) && externalRef) {
      const existingId = await findLeadByExternalRef(db, tenantId, externalRef);
      if (existingId) {
        await db.from("sales_leads").update(updateFields).eq("id", existingId);
        return existingId;
      }
    }
    throw new Error(error.message);
  }
  return (data as { id: string }).id;
}

async function findLeadByExternalRef(
  db: DB,
  tenantId: string,
  externalRef: string
): Promise<string | null> {
  const { data } = await db
    .from("sales_leads")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("external_ref", externalRef)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? (data as { id: string }).id : null;
}

// --------------------------------------------------------------------------
// deal / opportunity + invitation
// --------------------------------------------------------------------------

/** resolve customer_id จาก payload (id ตรง / customer_code) — ต้องมีจริงใน tenant */
async function resolveCustomerId(
  db: DB,
  tenantId: string,
  opts: { customer_id?: string; customer_code?: string }
): Promise<string> {
  if (opts.customer_id) {
    return assertCustomerInTenant(db, tenantId, opts.customer_id);
  }
  if (opts.customer_code) {
    const { data } = await db
      .from("customers")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("customer_code", opts.customer_code)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) {
      throw new IntegrationValidationError(
        "ไม่พบลูกค้าใน tenant นี้ (customer_code ไม่ถูกต้อง)"
      );
    }
    return (data as { id: string }).id;
  }
  throw new IntegrationValidationError("ต้องระบุ customer_id หรือ customer_code");
}

export type DealResult = {
  opportunityId: string;
  created: boolean;
  statusChanged: boolean;
  previousStatus: string | null;
  /** สถานะการ map เซล (มีเมื่อ payload ส่ง sales_employee_id/name มา) */
  salesEmployee?: { resolved: boolean; reason?: "not_found" | "ambiguous" };
  invitation?: {
    id: string;
    created: boolean;
    token: string;
    surveyType: "C" | "D";
  };
};

/**
 * upsert ดีลตาม external_ref (idempotent) + บันทึกประวัติสถานะ
 * เมื่อ Won/Lost → enqueue แบบประเมินเซล
 */
export async function upsertDealAndMaybeInvite(
  db: DB,
  payload: DealStatusPayload
): Promise<DealResult> {
  // cross-tenant validation
  const customerId = await resolveCustomerId(db, payload.tenant_id, {
    customer_id: payload.customer_id,
    customer_code: payload.customer_code,
  });
  // resolve เซลผู้ถูกประเมิน: uuid ตรง หรือชื่อจาก roster NOVA Sales → employee_id
  const salesRequested = !!(
    payload.sales_employee_id || payload.sales_employee_name
  );
  const salesResolution = await resolveSalesEmployeeId(db, payload.tenant_id, {
    id: payload.sales_employee_id,
    name: payload.sales_employee_name,
  });
  const salesEmployeeId = salesResolution.employeeId;

  const closedAt =
    payload.status === "open"
      ? null
      : payload.closed_at ?? new Date().toISOString();

  const existing = await findOpportunityByExternalRef(
    db,
    payload.tenant_id,
    payload.external_deal_id
  );

  let opportunityId: string;
  let created: boolean;
  let previousStatus: string | null = null;

  if (existing) {
    opportunityId = existing.id;
    previousStatus = existing.status;
    created = false;
    await db
      .from("sales_opportunities")
      .update({
        customer_id: customerId,
        sales_employee_id: salesEmployeeId ?? undefined,
        stage: payload.stage ?? undefined,
        amount: payload.amount ?? undefined,
        status: payload.status,
        closed_at: closedAt,
      })
      .eq("id", opportunityId);
  } else {
    const insertRow = {
      tenant_id: payload.tenant_id,
      external_ref: payload.external_deal_id,
      customer_id: customerId,
      sales_employee_id: salesEmployeeId ?? null,
      stage: payload.stage ?? null,
      amount: payload.amount ?? null,
      status: payload.status,
      closed_at: closedAt,
    };
    const { data, error } = await db
      .from("sales_opportunities")
      .insert(insertRow)
      .select("id")
      .single();

    if (error) {
      // race: มีคนสร้างไปแล้ว → re-select แล้ว update (idempotent)
      if (isUniqueViolation(error)) {
        const dup = await findOpportunityByExternalRef(
          db,
          payload.tenant_id,
          payload.external_deal_id
        );
        if (dup) {
          opportunityId = dup.id;
          previousStatus = dup.status;
          created = false;
          await db
            .from("sales_opportunities")
            .update({ status: payload.status, closed_at: closedAt })
            .eq("id", opportunityId);
        } else {
          throw new Error(error.message);
        }
      } else {
        throw new Error(error.message);
      }
    } else {
      opportunityId = (data as { id: string }).id;
      created = true;
    }
  }

  const statusChanged = previousStatus !== payload.status;
  if (statusChanged) {
    await db.from("sales_status_history").insert({
      tenant_id: payload.tenant_id,
      opportunity_id: opportunityId,
      from_status: previousStatus,
      to_status: payload.status,
    });
  }

  const result: DealResult = {
    opportunityId,
    created,
    statusChanged,
    previousStatus,
  };

  // แจ้งสถานะ map เซล เฉพาะเมื่อ payload ตั้งใจส่งเซลมา (กันสับสนกรณีไม่ส่งเลย)
  if (salesRequested) {
    result.salesEmployee = {
      resolved: salesEmployeeId !== null,
      ...(salesEmployeeId === null ? { reason: salesResolution.reason as "not_found" | "ambiguous" } : {}),
    };
  }

  const surveyType = dealStatusToSurveyType(payload.status);
  if (surveyType) {
    const invitation = await enqueueSalesInvitation(db, {
      tenantId: payload.tenant_id,
      customerId,
      opportunityId,
      salesEmployeeId,
      salesEmployeeName: salesResolution.name,
      externalDealId: payload.external_deal_id,
      surveyType,
    });
    if (invitation) result.invitation = { ...invitation, surveyType };
  }

  return result;
}

async function findOpportunityByExternalRef(
  db: DB,
  tenantId: string,
  externalRef: string
): Promise<{ id: string; status: string } | null> {
  const { data } = await db
    .from("sales_opportunities")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("external_ref", externalRef)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? (data as { id: string; status: string }) : null;
}

/** หา line_users.id หลักของลูกค้า (ผูก invitation กับเจ้าของ) — best-effort */
async function findCustomerLineUserId(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<string | null> {
  const { data } = await db
    .from("line_users")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("is_blocked", false)
    .is("deleted_at", null)
    .order("linked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? (data as { id: string }).id : null;
}

/**
 * สร้าง survey_invitation สำหรับดีล (C/D) — idempotent + คืน token
 *   - idempotency_key + unique(customer_id, survey_type, cycle_period) กันซ้ำ
 *   - ผูก line_user_id ถ้ามี (owner-binding)
 *   - C (Won): enqueue notification job → push ผ่าน OA Sale เหมือนเดิม
 *   - D (Lost): ไม่ enqueue notification job (prospect มักไม่ได้แอด OA)
 *     → คืน token ให้ route ประกอบ survey_url ส่งกลับ NOVA Sales/เซล เอาไปส่งเอง
 */
export async function enqueueSalesInvitation(
  db: DB,
  args: {
    tenantId: string;
    customerId: string;
    opportunityId: string;
    salesEmployeeId: string | null;
    salesEmployeeName?: string | null;
    externalDealId: string;
    surveyType: "C" | "D";
  }
): Promise<{ id: string; created: boolean; token: string } | null> {
  const idempotencyKey = dealInvitationIdempotencyKey(
    args.externalDealId,
    args.surveyType
  );

  const existing = await findInvitationByIdempotency(
    db,
    args.tenantId,
    idempotencyKey
  );
  if (existing) {
    return { id: existing.id, created: false, token: existing.token };
  }

  const found = await getActiveVersionByType(db, args.tenantId, args.surveyType);
  if (!found) return null; // ยังไม่ตั้ง template — ข้าม (route รายงาน invitation=null)

  const lineUserId = await findCustomerLineUserId(
    db,
    args.tenantId,
    args.customerId
  );

  // snapshot เซลผู้ถูกประเมิน (subject_role: 'sales') → dashboard/report attribute ต่อเซลได้
  // ว่าง = ประเมินแบบไม่ระบุตัวเซล (ชื่อไม่ตรง roster / กำกวม / ไม่ได้ส่งเซลมา)
  const assigneeSnapshot = args.salesEmployeeId
    ? [
        {
          employee_id: args.salesEmployeeId,
          ...(args.salesEmployeeName ? { name: args.salesEmployeeName } : {}),
          subject_role: "sales",
        },
      ]
    : [];

  // สร้าง token ไว้ล่วงหน้าเพื่อ insert + คืนกลับให้ route ประกอบ survey_url
  const token = generateInvitationToken();

  const { data, error } = await db
    .from("survey_invitations")
    .insert({
      tenant_id: args.tenantId,
      customer_id: args.customerId,
      line_user_id: lineUserId,
      survey_type: args.surveyType,
      survey_version_id: found.version.id,
      opportunity_id: args.opportunityId,
      cycle_period: dealCyclePeriod(args.externalDealId),
      assignee_snapshot: assigneeSnapshot,
      token,
      token_expires_at: new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      ).toISOString(),
      status: "pending",
      idempotency_key: idempotencyKey,
    })
    .select("id")
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const dup = await findInvitationByIdempotency(
        db,
        args.tenantId,
        idempotencyKey
      );
      return dup ? { id: dup.id, created: false, token: dup.token } : null;
    }
    throw new Error(error.message);
  }

  const invitationId = (data as { id: string }).id;

  // C (Won) เท่านั้นที่ push ผ่าน OA — D (Lost) ไม่ enqueue เพื่อไม่ให้มี job ค้าง
  // ที่ push ไม่ถึง (prospect มักไม่ได้แอด OA) แล้ว fail/retry ไม่จบ
  if (args.surveyType === "C") {
    await db.from("job_queue").insert({
      tenant_id: args.tenantId,
      queue: "notification",
      payload: {
        kind: "survey_invitation",
        invitation_id: invitationId,
        survey_type: args.surveyType,
        oa: "sale",
      },
    });
  }

  return { id: invitationId, created: true, token };
}

async function findInvitationByIdempotency(
  db: DB,
  tenantId: string,
  idempotencyKey: string
): Promise<{ id: string; token: string } | null> {
  const { data } = await db
    .from("survey_invitations")
    .select("id, token")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  return data ? (data as { id: string; token: string }) : null;
}
