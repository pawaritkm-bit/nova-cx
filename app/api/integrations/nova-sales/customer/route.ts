import { NextResponse, type NextRequest } from "next/server";
import {
  getSupabaseEnv,
  getNovaSalesApiKey,
  getNovaSalesTenantId,
} from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  checkNovaSalesAuth,
  checkTenantAllowed,
  customerUpsertSchema,
} from "@/lib/integrations/nova-sales";
import {
  upsertCustomer,
  upsertLead,
  softDeleteCustomerByExternalRef,
  IntegrationValidationError,
} from "@/lib/integrations/nova-sales-service";
import { newRequestId, logServerError, serverErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/integrations/nova-sales/customer
 * NOVA Sales ยิงเข้ามาเมื่อเปิด/อัปเดตลูกค้า → upsert customers (+lead) แบบ idempotent
 * Auth: header x-api-key = NOVA_SALES_API_KEY (+ ผูก tenant ผ่าน NOVA_SALES_TENANT_ID)
 */
export async function POST(request: NextRequest) {
  const requestId = newRequestId();

  const auth = checkNovaSalesAuth(request.headers, getNovaSalesApiKey());
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "payload ไม่ใช่ JSON" },
      { status: 400 }
    );
  }

  const parsed = customerUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // ผูก API key ↔ tenant (กันเขียนข้าม tenant)
  if (!checkTenantAllowed(parsed.data.tenant_id, getNovaSalesTenantId())) {
    return NextResponse.json(
      { error: "forbidden", message: "tenant_id ไม่ตรงกับ API key" },
      { status: 403 }
    );
  }

  const env = getSupabaseEnv();
  if (!env || !env.serviceRoleKey) {
    return NextResponse.json(
      { error: "service_unavailable", message: "ยังไม่ได้ตั้งค่า Supabase" },
      { status: 503 }
    );
  }

  try {
    const db = createServiceRoleClient();

    // delete-sync: NOVA Sales ส่ง deleted=true → soft-delete แทน upsert (idempotent)
    // (schema.superRefine การันตีว่ามี external_customer_id เมื่อ deleted=true แล้ว)
    if (parsed.data.deleted === true) {
      const result = await softDeleteCustomerByExternalRef(
        db,
        parsed.data.tenant_id,
        parsed.data.external_customer_id as string
      );
      return NextResponse.json(
        {
          ok: true,
          deleted: true,
          external_ref: parsed.data.external_customer_id,
          customer_id: result.customerId,
        },
        { status: 200 }
      );
    }

    const customer = await upsertCustomer(db, parsed.data);

    let leadId: string | null = null;
    if (parsed.data.lead) {
      leadId = await upsertLead(
        db,
        parsed.data.tenant_id,
        parsed.data.lead,
        customer.id
      );
    }

    return NextResponse.json(
      {
        ok: true,
        customer_id: customer.id,
        created: customer.created,
        lead_id: leadId,
      },
      { status: customer.created ? 201 : 200 }
    );
  } catch (e) {
    if (e instanceof IntegrationValidationError) {
      return NextResponse.json(
        { error: "validation_error", message: e.message },
        { status: 400 }
      );
    }
    logServerError("nova-sales/customer", requestId, e);
    return serverErrorResponse(requestId);
  }
}
