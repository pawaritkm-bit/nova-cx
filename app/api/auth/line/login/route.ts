import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import {
  getLineLoginChannelId,
  getLineLoginChannelSecret,
  getLineLoginRedirectUri,
  getStaffSessionSecret,
} from "@/lib/env";
import { buildLineAuthorizeUrl, type LineLoginState } from "@/lib/line/login";
import { signToken } from "@/lib/crypto/hmac-token";
import { LINE_STATE_COOKIE } from "@/lib/staff/cookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** ปลายทาง default หลัง login สำเร็จ (หน้าลงบันทึกบัญชีของนักบัญชี) */
const DEFAULT_REDIRECT = "/chat-audit/accounting";
/** อายุ state = 10 นาที (พอสำหรับ login) */
const STATE_TTL_SEC = 10 * 60;

/** รับเฉพาะ path ภายใน (กัน open-redirect) */
function safeInternalPath(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return DEFAULT_REDIRECT;
}

/**
 * GET /api/auth/line/login — เริ่ม flow "เข้าสู่ระบบด้วย LINE" (staff/นักบัญชี)
 *   1) เช็ก env ครบ (channel id/secret/redirect/session secret) — ไม่ครบ → กลับ /login?error
 *   2) ออก state (signed) ผูก redirect + nonce → เก็บใน cookie (CSRF) + แนบไป LINE
 *   3) redirect ไปหน้า authorize ของ LINE
 */
export async function GET(request: NextRequest) {
  const channelId = getLineLoginChannelId();
  const channelSecret = getLineLoginChannelSecret();
  const sessionSecret = getStaffSessionSecret();
  const redirectUri = getLineLoginRedirectUri();

  if (!channelId || !channelSecret || !sessionSecret) {
    return NextResponse.redirect(
      new URL("/login?error=line_unavailable", request.url),
      { status: 303 }
    );
  }

  const redirectTo = safeInternalPath(request.nextUrl.searchParams.get("redirect"));
  const nonce = randomUUID();
  const state = signToken(
    {
      redirect: redirectTo,
      nonce,
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SEC,
    } satisfies LineLoginState,
    sessionSecret
  );

  const authorizeUrl = buildLineAuthorizeUrl({
    channelId,
    redirectUri,
    state,
    nonce,
  });

  const res = NextResponse.redirect(authorizeUrl, { status: 303 });
  // เก็บ state ผูก browser นี้ (เทียบตอน callback กัน CSRF) — httpOnly + อายุสั้น
  res.cookies.set(LINE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_SEC,
  });
  return res;
}
