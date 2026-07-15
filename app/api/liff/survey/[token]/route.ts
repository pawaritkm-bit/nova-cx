import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { newRequestId, logServerError, serverErrorResponse } from "@/lib/http";
import {
  getInvitationByToken,
  getVersionById,
  getCustomerRef,
  getEvaluationSubjects,
} from "@/lib/survey/service";
import { flattenQuestions } from "@/lib/survey/schema";
import {
  verifyInvitationAccess,
  accessReasonMessage,
} from "@/lib/survey/token";
import { SURVEY_SLUG_BY_TYPE } from "@/lib/survey/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/liff/survey/[token]
 * โหลดแบบประเมินของลูกค้าตาม invitation token:
 *   - ตรวจ token: มีจริง + ยังไม่ตอบ + ไม่หมดอายุ + เป็นเจ้าของ (FR-LN-05)
 *   - คืน schema (versioned JSON) + คำถาม flatten + auto-fill ข้อมูลอ้างอิง
 *   - Form B: คืนรายชื่อผู้ถูกประเมิน (ผูกอัตโนมัติจาก assignee snapshot)
 * customer flow ผ่าน service-role ที่ scope ด้วย token (ไม่พึ่ง anon key — บทเรียน M1)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const requestId = newRequestId();

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
    const invitation = await getInvitationByToken(db, token);

    // NOTE (🟠#5): ยังไม่ใช้ LINE userId จาก client ตัดสินสิทธิ์ (spoof ได้)
    // → owner-binding เต็มรูปทำใน chunk ที่มี LINE ID-token verify
    const access = verifyInvitationAccess({
      invitation,
      requesterLineUserId: null,
    });
    if (!access.ok) {
      const status = access.reason === "not_found" ? 404 : 403;
      return NextResponse.json(
        { error: access.reason, message: accessReasonMessage(access.reason) },
        { status }
      );
    }
    // access.ok = true → invitation ไม่เป็น null (verify คืน not_found เมื่อ null)
    const inv = invitation!;

    const version = await getVersionById(db, inv.survey_version_id);
    if (!version) {
      return NextResponse.json(
        { error: "not_found", message: "ไม่พบเวอร์ชันแบบประเมิน" },
        { status: 404 }
      );
    }

    const customer = await getCustomerRef(db, inv.customer_id);

    // อัปเดตสถานะ opened (best-effort; ไม่ให้ล้มถ้าพลาด)
    if (inv.status === "pending" || inv.status === "sent") {
      await db
        .from("survey_invitations")
        .update({ status: "opened" })
        .eq("id", inv.id);
    }

    return NextResponse.json({
      token,
      survey_type: inv.survey_type,
      survey_slug: SURVEY_SLUG_BY_TYPE[inv.survey_type],
      version: { id: version.id, version_no: version.version_no },
      schema: version.schema_json,
      questions: flattenQuestions(version.schema_json),
      reference: customer
        ? {
            customer_code: customer.customer_code,
            name: customer.name,
            business_name: customer.business_name,
            service_start_date: customer.service_start_date,
          }
        : null,
      // Form B: ผู้ถูกประเมินที่ระบบผูกอัตโนมัติ (ลูกค้าไม่ต้องเลือกเอง)
      subjects: inv.survey_type === "B" ? getEvaluationSubjects(inv) : [],
    });
  } catch (e) {
    logServerError("liff/survey", requestId, e);
    return serverErrorResponse(requestId);
  }
}
