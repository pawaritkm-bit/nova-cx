import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { surveyTypeFromSlug, isSurveyType } from "@/lib/survey/types";
import { getActiveVersionByType } from "@/lib/survey/service";
import { flattenQuestions } from "@/lib/survey/schema";
import { newRequestId, logServerError, serverErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/survey/template?type=office|accountant|sales-won|sales-lost[&tenant_id=...]
 * (รองรับ type=A|B|C|D ด้วย) — คืน versioned JSON + คำถามที่ flatten แล้ว + conditional rules
 * ใช้สำหรับ preview/dev/admin (customer flow ใช้ /api/liff/survey/[token])
 */
export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  const { searchParams } = new URL(request.url);
  const typeParam = searchParams.get("type") ?? "";
  const tenantId = searchParams.get("tenant_id");

  const surveyType = isSurveyType(typeParam)
    ? typeParam
    : surveyTypeFromSlug(typeParam);

  if (!surveyType) {
    return NextResponse.json(
      {
        error: "invalid_type",
        message:
          "ระบุ type เป็น office | accountant | sales-won | sales-lost (หรือ A|B|C|D)",
      },
      { status: 400 }
    );
  }

  const env = getSupabaseEnv();
  if (!env || !env.serviceRoleKey) {
    return NextResponse.json(
      {
        error: "service_unavailable",
        message: "ยังไม่ได้ตั้งค่า Supabase (SUPABASE_SERVICE_ROLE_KEY)",
      },
      { status: 503 }
    );
  }

  try {
    const db = createServiceRoleClient();
    const found = await getActiveVersionByType(db, tenantId, surveyType);
    if (!found) {
      return NextResponse.json(
        { error: "not_found", message: "ไม่พบแบบประเมินที่ active สำหรับชนิดนี้" },
        { status: 404 }
      );
    }

    const { template, version } = found;
    return NextResponse.json({
      survey_type: surveyType,
      template: { id: template.id, name: template.name },
      version: { id: version.id, version_no: version.version_no },
      schema: version.schema_json,
      questions: flattenQuestions(version.schema_json),
    });
  } catch (e) {
    logServerError("survey/template", requestId, e);
    return serverErrorResponse(requestId);
  }
}
