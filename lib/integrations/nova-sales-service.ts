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
 *   - Won/Lost → enqueue survey_invitation (C/D) + notification job
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

/** ยืนยันพนักงานอยู่ tenant นี้ + ไม่ soft-deleted */
async function assertEmployeeInTenant(
  db: DB,
  tenantId: string,
  employeeId: string,
  field: string
): Promise<void> {
  const { data } = await db
    .from("employees")
    .select("id")
    .eq("id", employeeId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) {
    throw new IntegrationValidationError(
      `ไม่พบพนักงานใน tenant นี้ (${field} ไม่ถูกต้อง)`
    );
  }
}

// --------------------------------------------------------------------------
// customer / lead
// --------------------------------------------------------------------------

/** upsert ลูกค้าตาม external_ref (idempotent + จับ 23505) → คืน customer id */
export async function upsertCustomer(
  db: DB,
  payload: CustomerUpsertPayload
): Promise<{ id: string; created: boolean }> {
  const externalRef = payload.external_customer_id ?? null;

  const updateFields = {
    name: payload.name,
    business_name: payload.business_name ?? null,
    service_start_date: payload.service_start_date ?? null,
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.customer_code ? { customer_code: payload.customer_code } : {}),
  };

  // fast path: หาโดย external_ref
  if (externalRef) {
    const existingId = await findCustomerByExternalRef(db, payload.tenant_id, externalRef);
    if (existingId) {
      await db.from("customers").update(updateFields).eq("id", existingId);
      return { id: existingId, created: false };
    }
  }

  // insert ใหม่ (จับ 23505 = race → re-select แล้ว update)
  const { data, error } = await db
    .from("customers")
    .insert({
      tenant_id: payload.tenant_id,
      external_ref: externalRef,
      customer_code: payload.customer_code ?? null,
      name: payload.name,
      business_name: payload.business_name ?? null,
      service_start_date: payload.service_start_date ?? null,
      status: payload.status ?? "active",
    })
    .select("id")
    .single();

  if (error) {
    if (isUniqueViolation(error) && externalRef) {
      const existingId = await findCustomerByExternalRef(db, payload.tenant_id, externalRef);
      if (existingId) {
        await db.from("customers").update(updateFields).eq("id", existingId);
        return { id: existingId, created: false };
      }
    }
    throw new Error(error.message);
  }
  return { id: (data as { id: string }).id, created: true };
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
  invitation?: { id: string; created: boolean; surveyType: "C" | "D" };
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
  if (payload.sales_employee_id) {
    await assertEmployeeInTenant(
      db,
      payload.tenant_id,
      payload.sales_employee_id,
      "sales_employee_id"
    );
  }

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
        sales_employee_id: payload.sales_employee_id ?? undefined,
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
      sales_employee_id: payload.sales_employee_id ?? null,
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

  const surveyType = dealStatusToSurveyType(payload.status);
  if (surveyType) {
    const invitation = await enqueueSalesInvitation(db, {
      tenantId: payload.tenant_id,
      customerId,
      opportunityId,
      salesEmployeeId: payload.sales_employee_id ?? null,
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
 * สร้าง survey_invitation สำหรับดีล (C/D) + notification job — idempotent
 *   - idempotency_key + unique(customer_id, survey_type, cycle_period) กันซ้ำ
 *   - ผูก line_user_id ถ้ามี (owner-binding) — ยังไม่ส่ง LINE จริงในรอบนี้
 */
export async function enqueueSalesInvitation(
  db: DB,
  args: {
    tenantId: string;
    customerId: string;
    opportunityId: string;
    salesEmployeeId: string | null;
    externalDealId: string;
    surveyType: "C" | "D";
  }
): Promise<{ id: string; created: boolean } | null> {
  const idempotencyKey = dealInvitationIdempotencyKey(
    args.externalDealId,
    args.surveyType
  );

  const existingId = await findInvitationByIdempotency(
    db,
    args.tenantId,
    idempotencyKey
  );
  if (existingId) return { id: existingId, created: false };

  const found = await getActiveVersionByType(db, args.tenantId, args.surveyType);
  if (!found) return null; // ยังไม่ตั้ง template — ข้าม (route รายงาน invitation=null)

  const lineUserId = await findCustomerLineUserId(
    db,
    args.tenantId,
    args.customerId
  );

  const assigneeSnapshot = args.salesEmployeeId
    ? [{ employee_id: args.salesEmployeeId, subject_role: "member" }]
    : [];

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
      token: generateInvitationToken(),
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
      const dupId = await findInvitationByIdempotency(
        db,
        args.tenantId,
        idempotencyKey
      );
      return dupId ? { id: dupId, created: false } : null;
    }
    throw new Error(error.message);
  }

  const invitationId = (data as { id: string }).id;

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

  return { id: invitationId, created: true };
}

async function findInvitationByIdempotency(
  db: DB,
  tenantId: string,
  idempotencyKey: string
): Promise<string | null> {
  const { data } = await db
    .from("survey_invitations")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  return data ? (data as { id: string }).id : null;
}
