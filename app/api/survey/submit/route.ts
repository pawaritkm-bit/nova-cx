import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  getInvitationByToken,
  getVersionById,
  getEvaluationSubjects,
  persistSurveyResponse,
  DuplicateSubmissionError,
} from "@/lib/survey/service";
import { flattenQuestions } from "@/lib/survey/schema";
import {
  submitPayloadSchema,
  validateAnswers,
  requiredQuestionCodes,
} from "@/lib/survey/submit";
import {
  verifyInvitationAccess,
  accessReasonMessage,
} from "@/lib/survey/token";
import { computeCsat, computeNps } from "@/lib/survey/scoring";
import { buildConsentPayload } from "@/lib/pdpa";
import { newRequestId, logServerError, serverErrorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/survey/submit
 * รับคำตอบจาก LIFF → validate (Zod + conditional/exclusive ฝั่ง server)
 *   → บันทึก response/answers + คำนวณ CSAT/NPS → ปิด invitation → enqueue AI
 * idempotent: unique(invitation_id) กันตอบซ้ำ → ตอบ 409 อย่างสุภาพ
 */
export async function POST(request: NextRequest) {
  const requestId = newRequestId();

  // 1) validate payload (Zod)
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "payload ไม่ใช่ JSON ที่ถูกต้อง" },
      { status: 400 }
    );
  }

  const parsed = submitPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "validation_error",
        message: "ข้อมูลไม่ถูกต้อง",
        issues: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }
  const { token, answers, consent } = parsed.data;

  // consent PDPA บังคับจริง (ไม่รับค่าที่ไม่ยินยอม — FR-SC-04c/FR-PD)
  if (consent !== true) {
    return NextResponse.json(
      { error: "consent_required", message: "ต้องยินยอมนโยบายข้อมูลก่อนส่งแบบประเมิน" },
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

    // 2) load + verify invitation (มีจริง/หมดอายุ/ยังไม่ตอบ)
    //    NOTE (🟠#5): ไม่ใช้ lineUserId จาก client ตัดสินสิทธิ์เจ้าของ (spoof ได้)
    //    → owner-binding เต็มรูป (verify LINE ID token → line_users.id) ทำใน chunk ที่มี LINE env
    const invitation = await getInvitationByToken(db, token);
    const access = verifyInvitationAccess({
      invitation,
      requesterLineUserId: null,
    });
    if (!access.ok) {
      const status =
        access.reason === "not_found"
          ? 404
          : access.reason === "already_responded"
            ? 409
            : 403;
      return NextResponse.json(
        { error: access.reason, message: accessReasonMessage(access.reason) },
        { status }
      );
    }
    const inv = invitation!;

    // 3) load template version + flatten คำถาม
    const version = await getVersionById(db, inv.survey_version_id);
    if (!version) {
      return NextResponse.json(
        { error: "not_found", message: "ไม่พบเวอร์ชันแบบประเมิน" },
        { status: 404 }
      );
    }
    // Form B: expand คำถามต่อผู้ถูกประเมิน (per-subject key) ให้ตรงกับที่ client ส่ง
    const subjects =
      inv.survey_type === "B" ? getEvaluationSubjects(inv) : [];
    const questions = flattenQuestions(version.schema_json, { subjects });

    // 4) validate คำตอบ (conditional/exclusive/ช่วงคะแนน + บังคับตอบ rating/nps — server-side)
    const required = requiredQuestionCodes(questions);
    const check = validateAnswers(questions, answers, required);
    if (!check.ok) {
      return NextResponse.json(
        { error: "answer_invalid", message: "คำตอบไม่ผ่านการตรวจสอบ", errors: check.errors },
        { status: 400 }
      );
    }

    // 5) คำนวณ CSAT/NPS + บันทึกแบบ atomic (RPC) + เขียน consent
    const csat = computeCsat(questions, answers);
    const nps = computeNps(questions, answers);

    const { responseId } = await persistSurveyResponse(db, {
      invitation: inv,
      answers,
      csat,
      nps,
      consent: buildConsentPayload(),
    });

    return NextResponse.json(
      {
        ok: true,
        response_id: responseId,
        csat: csat.overall,
        nps: nps?.category ?? null,
      },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof DuplicateSubmissionError) {
      return NextResponse.json(
        { error: "already_responded", message: "แบบประเมินนี้ถูกส่งไปแล้ว ขอบคุณค่ะ" },
        { status: 409 }
      );
    }
    logServerError("survey/submit", requestId, e);
    return serverErrorResponse(requestId);
  }
}
