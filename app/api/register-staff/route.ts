import { NextResponse, type NextRequest } from "next/server";
import {
  getSupabaseEnv,
  getStaffRegisterCode,
  getLineLoginChannelId,
  getLineTenantId,
} from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { constantTimeEqual, newRequestId, logServerError, serverErrorResponse } from "@/lib/http";
import { verifyLineIdToken } from "@/lib/line/verify-id-token";
import { registerStaffSchema } from "@/lib/register-staff/schema";
import { registerStaff, resolveRegisterTenantId } from "@/lib/register-staff/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/register-staff
 * ลงทะเบียนนักบัญชีผ่าน QR (LIFF): ผูก LINE userId ↔ พนักงาน + propagate ไปทุกกลุ่ม
 *
 * ความปลอดภัย (ในกลุ่มมีลูกค้า — ต้องกันคนนอก/ลูกค้าลงทะเบียนเป็นนักบัญชี):
 *   1) STAFF_REGISTER_CODE ต้องตั้งค่า มิฉะนั้น 503 (fail-safe ปิดฟีเจอร์)
 *   2) code ที่ส่งมาต้องตรง (constant-time compare) มิฉะนั้น 403
 *   3) verify idToken กับ LINE → ได้ userId จริง (ไม่เชื่อ userId ที่ client ส่ง)
 *   4) tenant resolve ฝั่ง server (ไม่เชื่อ client)
 */
export async function POST(request: NextRequest) {
  const requestId = newRequestId();

  // (1) ฟีเจอร์เปิดเมื่อมีทั้งรหัสลงทะเบียน + login channel id (สำหรับ verify idToken)
  const registerCode = getStaffRegisterCode();
  const loginChannelId = getLineLoginChannelId();
  if (!registerCode || !loginChannelId) {
    return NextResponse.json(
      {
        error: "service_unavailable",
        message: "ระบบลงทะเบียนยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแล",
      },
      { status: 503 }
    );
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

  const parsed = registerStaffSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // (2) verify รหัสลงทะเบียน (constant-time) — กันลูกค้า/คนนอก
  if (!constantTimeEqual(parsed.data.code, registerCode)) {
    return NextResponse.json(
      { error: "forbidden", message: "รหัสลงทะเบียนไม่ถูกต้อง" },
      { status: 403 }
    );
  }

  // (3) verify idToken กับ LINE → userId จริง
  const identity = await verifyLineIdToken(parsed.data.idToken, loginChannelId);
  if (!identity) {
    return NextResponse.json(
      { error: "unauthorized", message: "ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาลองใหม่" },
      { status: 401 }
    );
  }

  // (4) ต้องตั้งค่า Supabase (service-role) ถึงจะเขียนได้
  const env = getSupabaseEnv();
  if (!env || !env.serviceRoleKey) {
    return NextResponse.json(
      { error: "service_unavailable", message: "ยังไม่ได้ตั้งค่าฐานข้อมูล" },
      { status: 503 }
    );
  }

  try {
    const db = createServiceRoleClient();
    const tenantId = await resolveRegisterTenantId(db, getLineTenantId());
    if (!tenantId) {
      return NextResponse.json(
        { error: "service_unavailable", message: "ยังไม่พบสำนักงานในระบบ" },
        { status: 503 }
      );
    }

    const result = await registerStaff(db, tenantId, {
      userId: identity.userId,
      // ใช้ชื่อจากฟอร์มเป็นหลัก; ถ้าเว้นว่างจริง ๆ ใช้ชื่อจาก LINE (best-effort)
      name: parsed.data.name || identity.name || "นักบัญชี",
      nickname: parsed.data.nickname ?? null,
      teamName: parsed.data.teamName ?? null,
      teamId: parsed.data.teamId ?? null,
    });

    // userId ย่อ (ให้เทียบกับ chat_members ตอนทดสอบ provider ได้ โดยไม่โชว์เต็ม)
    const userIdShort =
      identity.userId.length > 10
        ? `${identity.userId.slice(0, 6)}…${identity.userId.slice(-4)}`
        : identity.userId;

    return NextResponse.json(
      {
        ok: true,
        employeeName: result.employeeName,
        userIdShort,
        created: result.created,
        teamLinked: result.teamLinked,
        teamName: result.teamName,
        propagatedGroups: result.propagatedGroups,
      },
      { status: 200 }
    );
  } catch (e) {
    logServerError("register-staff", requestId, e);
    return serverErrorResponse(requestId);
  }
}
