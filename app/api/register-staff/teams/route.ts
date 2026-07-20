import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv, getStaffRegisterCode, getLineTenantId } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { constantTimeEqual, newRequestId, logServerError, serverErrorResponse } from "@/lib/http";
import {
  listAccountingTeamsWithLeader,
  resolveRegisterTenantId,
} from "@/lib/register-staff/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/register-staff/teams
 * คืนรายชื่อ "ทีมบัญชี + หัวหน้า" สำหรับ dropdown หน้า /reg/staff
 *
 * ความปลอดภัย:
 *   - ต้อง verify รหัสลงทะเบียน (constant-time) ก่อนคืนรายชื่อ — กัน leak ชื่อหัวหน้า
 *     ให้ลูกค้า/คนนอกที่ไม่มีรหัส
 *   - ไม่ตั้ง STAFF_REGISTER_CODE = ปิดฟีเจอร์ (503)
 *   - tenant resolve ฝั่ง server (ไม่เชื่อ client)
 */
export async function POST(request: NextRequest) {
  const requestId = newRequestId();

  const registerCode = getStaffRegisterCode();
  if (!registerCode) {
    return NextResponse.json(
      { error: "service_unavailable", message: "ระบบลงทะเบียนยังไม่พร้อมใช้งาน" },
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

  const code = (body as { code?: unknown })?.code;
  if (typeof code !== "string" || !code) {
    return NextResponse.json(
      { error: "validation_error", message: "กรุณากรอกรหัสลงทะเบียน" },
      { status: 400 }
    );
  }

  // verify รหัส (constant-time) — ผิด = ไม่คืนรายชื่อ (กัน leak)
  if (!constantTimeEqual(code, registerCode)) {
    return NextResponse.json(
      { error: "forbidden", message: "รหัสลงทะเบียนไม่ถูกต้อง" },
      { status: 403 }
    );
  }

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

    const teams = await listAccountingTeamsWithLeader(db, tenantId);
    return NextResponse.json({ ok: true, teams }, { status: 200 });
  } catch (e) {
    logServerError("register-staff/teams", requestId, e);
    return serverErrorResponse(requestId);
  }
}
