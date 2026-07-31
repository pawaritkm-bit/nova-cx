import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv, getStaffRegisterCode, getLineTenantId } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { constantTimeEqual, newRequestId, logServerError, serverErrorResponse } from "@/lib/http";
import {
  listRegisterableEmployees,
  resolveRegisterTenantId,
} from "@/lib/register-staff/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/register-staff/employees
 * คืนรายชื่อพนักงานเดิม "ที่ยังไม่ผูก LINE" ให้ผู้ลงทะเบียนเลือกตัวเอง (dropdown หน้า /reg/staff)
 *
 * ความปลอดภัย (pattern เดียวกับ /api/register-staff/teams):
 *   - ต้อง verify รหัสลงทะเบียน (constant-time) ก่อนคืนรายชื่อ — กันคนนอก/ลูกค้าดูรายชื่อพนักงาน
 *   - ไม่ตั้ง STAFF_REGISTER_CODE = ปิดฟีเจอร์ (503, fail-closed)
 *   - tenant resolve ฝั่ง server (ไม่เชื่อ client)
 *   - ★ PDPA: คืนแค่ { id, name } เท่านั้น — ไม่คืน/ไม่ log line_user_id หรือ PII อื่น
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

    const employees = await listRegisterableEmployees(db, tenantId);
    return NextResponse.json({ ok: true, employees }, { status: 200 });
  } catch (e) {
    logServerError("register-staff/employees", requestId, e);
    return serverErrorResponse(requestId);
  }
}
