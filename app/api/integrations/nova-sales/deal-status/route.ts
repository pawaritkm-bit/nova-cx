import { NextResponse, type NextRequest } from "next/server";
import {
  getSupabaseEnv,
  getNovaSalesApiKey,
  getNovaSalesTenantId,
  getAppBaseUrl,
} from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  checkNovaSalesAuth,
  checkTenantAllowed,
  dealStatusSchema,
} from "@/lib/integrations/nova-sales";
import {
  upsertDealAndMaybeInvite,
  IntegrationValidationError,
} from "@/lib/integrations/nova-sales-service";
import { newRequestId, logServerError, serverErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/integrations/nova-sales/deal-status
 * NOVA Sales ยิงเข้ามาเมื่อปิดดีล/เปลี่ยนสถานะ → upsert opportunity + history
 * เมื่อ Won → แบบประเมิน C, Lost → แบบประเมิน D (enqueue invitation ผ่าน OA Sale)
 * idempotent: external_deal_id + idempotency_key กันยิงซ้ำ
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

  const parsed = dealStatusSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  if (!parsed.data.customer_id && !parsed.data.customer_code) {
    return NextResponse.json(
      {
        error: "validation_error",
        message: "ต้องระบุ customer_id หรือ customer_code อย่างใดอย่างหนึ่ง",
      },
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
    const result = await upsertDealAndMaybeInvite(db, parsed.data);

    // ลิงก์เว็บที่เปิดในเบราว์เซอร์ไหนก็ได้ (ไม่ต้องแอด OA/ไม่ต้องเป็น LIFF-only)
    //   Won (C): push ผ่าน OA แล้ว แต่คืนลิงก์เผื่อ forward
    //   Lost (D): ไม่ push OA → ลิงก์นี้คือช่องทางหลักให้เซลส่งให้ prospect เอง
    const inv = result.invitation;
    const surveyUrl = inv
      ? `${getAppBaseUrl()}/liff/survey?token=${encodeURIComponent(inv.token)}`
      : null;

    return NextResponse.json(
      {
        ok: true,
        opportunity_id: result.opportunityId,
        created: result.created,
        status_changed: result.statusChanged,
        previous_status: result.previousStatus,
        // แจ้ง NOVA Sales ว่า map ชื่อเซล → employee_id ติดไหม (debug ชื่อไม่ตรง roster)
        sales_employee: result.salesEmployee ?? null,
        invitation: inv
          ? {
              id: inv.id,
              created: inv.created,
              survey_type: inv.surveyType,
            }
          : null,
        survey_url: surveyUrl,
      },
      { status: result.created ? 201 : 200 }
    );
  } catch (e) {
    if (e instanceof IntegrationValidationError) {
      return NextResponse.json(
        { error: "validation_error", message: e.message },
        { status: 400 }
      );
    }
    logServerError("nova-sales/deal-status", requestId, e);
    return serverErrorResponse(requestId);
  }
}
