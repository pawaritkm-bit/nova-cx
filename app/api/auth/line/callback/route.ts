import { NextResponse, type NextRequest } from "next/server";
import {
  getSupabaseEnv,
  getLineLoginChannelId,
  getLineLoginChannelSecret,
  getLineLoginRedirectUri,
  getStaffSessionSecret,
  getLineTenantId,
} from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { exchangeLineCodeForIdToken, type LineLoginState } from "@/lib/line/login";
import { verifyLineIdToken } from "@/lib/line/verify-id-token";
import { verifyToken, signToken } from "@/lib/crypto/hmac-token";
import { constantTimeEqual } from "@/lib/http";
import { resolveStaffEmployeeByLineUserId } from "@/lib/staff/employee";
import { STAFF_SESSION_COOKIE, LINE_STATE_COOKIE } from "@/lib/staff/cookie";
import { STAFF_SESSION_TTL_SEC } from "@/lib/staff/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_REDIRECT = "/chat-audit/accounting";

function loginError(request: NextRequest, code: string): NextResponse {
  const res = NextResponse.redirect(
    new URL(`/login?error=${code}`, request.url),
    { status: 303 }
  );
  // เคลียร์ state cookie เสมอ (ใช้แล้ว/ล้มเหลว)
  res.cookies.set(LINE_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

function safeInternalPath(raw: string | null | undefined): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return DEFAULT_REDIRECT;
}

/**
 * GET /api/auth/line/callback — ปลายทาง OAuth ของ LINE Login (staff/นักบัญชี)
 *   1) ถ้า LINE ส่ง error/ผู้ใช้ยกเลิก → /login?error
 *   2) verify state: cookie ต้องตรงกับ query (CSRF) + ลายเซ็น/อายุถูกต้อง
 *   3) แลก code → id_token → verify กับ LINE → ได้ userId จริง
 *   4) resolve เป็น employee (นักบัญชี active) — ไม่พบ = ปฏิเสธ
 *   5) ออก session cookie (signed, httpOnly) แล้ว redirect ไปปลายทาง (จาก state)
 *   ★ PDPA: ไม่ log line userId/ชื่อ/code/token
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  // (1) ผู้ใช้ปฏิเสธ / LINE ส่ง error
  if (sp.get("error")) return loginError(request, "line_denied");

  const code = sp.get("code") ?? "";
  const stateParam = sp.get("state") ?? "";
  if (!code || !stateParam) return loginError(request, "line_invalid");

  const channelId = getLineLoginChannelId();
  const channelSecret = getLineLoginChannelSecret();
  const sessionSecret = getStaffSessionSecret();
  const redirectUri = getLineLoginRedirectUri();
  const env = getSupabaseEnv();
  if (!channelId || !channelSecret || !sessionSecret || !env?.serviceRoleKey) {
    return loginError(request, "line_unavailable");
  }

  // (2) CSRF: cookie ต้องตรง query (constant-time) + ลายเซ็น/อายุถูกต้อง
  const stateCookie = request.cookies.get(LINE_STATE_COOKIE)?.value ?? "";
  if (!stateCookie || !constantTimeEqual(stateCookie, stateParam)) {
    return loginError(request, "line_state");
  }
  const state = verifyToken<LineLoginState>(stateParam, sessionSecret);
  if (!state || typeof state.redirect !== "string") {
    return loginError(request, "line_state");
  }

  // (3) แลก code → id_token → verify กับ LINE
  const exchanged = await exchangeLineCodeForIdToken({
    code,
    redirectUri,
    channelId,
    channelSecret,
  });
  if (!exchanged) return loginError(request, "line_exchange");

  const identity = await verifyLineIdToken(exchanged.idToken, channelId);
  if (!identity) return loginError(request, "line_verify");

  // (4) resolve เป็นพนักงาน (นักบัญชี active) — ไม่พบ = ไม่ใช่พนักงาน
  let employee;
  try {
    const service = createServiceRoleClient();
    employee = await resolveStaffEmployeeByLineUserId(
      service,
      identity.userId,
      getLineTenantId()
    );
  } catch {
    return loginError(request, "server");
  }
  if (!employee) {
    // ★★ ตัวตรวจชั่วคราว (ถอดออกหลัง debug เสร็จ) — บอกสาเหตุ resolve ไม่ผ่าน:
    //   dbg=notfound → userId ตอน login ไม่มีใน employees เลย = ไอดีคนละ provider กับที่เก็บ
    //   dbg=found;type=..;active=..;tenant=.. → มี record แต่ถูกกรอง (tenant/type/active ไม่ผ่าน)
    let dbg = "err";
    try {
      const svc = createServiceRoleClient();
      const { data: row } = await svc
        .from("employees")
        .select("tenant_id, employee_type, is_active, deleted_at")
        .eq("line_user_id", identity.userId)
        .limit(1)
        .maybeSingle();
      if (!row) {
        dbg = "notfound";
      } else {
        const r = row as {
          tenant_id: string | null;
          employee_type: string | null;
          is_active: boolean | null;
          deleted_at: string | null;
        };
        dbg = `found;type=${r.employee_type};active=${r.is_active};del=${r.deleted_at ? 1 : 0};tenant=${(r.tenant_id ?? "").slice(0, 8)}`;
      }
    } catch {
      dbg = "err";
    }
    const uidMask =
      identity.userId.length > 10
        ? `${identity.userId.slice(0, 6)}..${identity.userId.slice(-4)}`
        : identity.userId;
    const res = NextResponse.redirect(
      new URL(
        `/login?error=not_staff&uid=${encodeURIComponent(uidMask)}&dbg=${encodeURIComponent(dbg)}`,
        request.url
      ),
      { status: 303 }
    );
    res.cookies.set(LINE_STATE_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return res;
  }

  // (5) ออก session cookie (signed) แล้ว redirect ไปปลายทางภายใน
  const now = Math.floor(Date.now() / 1000);
  const token = signToken(
    {
      employeeId: employee.employeeId,
      tenantId: employee.tenantId,
      role: employee.role,
      name: employee.name,
      exp: now + STAFF_SESSION_TTL_SEC,
    },
    sessionSecret
  );

  const target = safeInternalPath(state.redirect);
  const res = NextResponse.redirect(new URL(target, request.url), { status: 303 });
  res.cookies.set(STAFF_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STAFF_SESSION_TTL_SEC,
  });
  // ใช้ state เสร็จแล้ว → ลบทิ้ง
  res.cookies.set(LINE_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
