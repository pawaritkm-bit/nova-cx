import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { shouldRedirectToLogin } from "@/lib/auth/guard";
import { STAFF_SESSION_COOKIE } from "@/lib/staff/cookie";
import { signTokenEdge, verifyTokenEdge } from "@/lib/crypto/hmac-token-edge";
import { STAFF_SESSION_TTL_SEC, staffSessionNeedsRenewal } from "@/lib/staff/cookie";

/**
 * รีเฟรช session ของพนักงาน (Supabase Auth) ในทุก request + guard /dashboard
 * - ถ้ายังไม่ตั้ง env → ปล่อยผ่าน ไม่ crash (dev/health)
 * - refresh token ที่หมดอายุด้วย supabase.auth.getUser() (pattern มาตรฐาน Supabase SSR)
 * - ไม่มี session แล้วเข้า /dashboard → redirect /login (แนบ ?redirect กลับมาหลัง login)
 * - เส้นทางสาธารณะ (LIFF/survey/integration/cron/static) ไม่ถูกกัน (ดู lib/auth/guard)
 */
export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request });

  const env = getSupabaseEnv();
  if (!env) return response;

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options: CookieOptions }[]
      ) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  // จำเป็นต้องเรียกเพื่อ refresh token ที่หมดอายุ + รู้ว่ามี session ไหม
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // staff (นักบัญชี) login ด้วย LINE ไม่มี Supabase user
  //   ★ 2026-09-03 ผู้ใช้: "กดยืนยันบิลแล้วโปรแกรมเด้งออก" — session 12 ชม. หมดกลางงาน:
  //     1) verify ลายเซ็นจริงที่ edge ด้วย Web Crypto (hmac-token-edge — รูปแบบเดียวกับฝั่ง node)
  //     2) sliding renewal: เหลือ < ครึ่งอายุ → re-sign ต่ออายุให้เอง (ใช้งานอยู่ = ไม่มีวันเด้ง)
  //     3) cookie หมดอายุ/ปลอม → ถือว่าไม่ล็อกอิน → เด้ง /login ทันทีพร้อมพากลับที่เดิม
  //   สิทธิ์จริงยัง verify ซ้ำที่หน้า/action ผ่าน resolveStaffContext (fail-closed) เหมือนเดิม
  const staffToken = request.cookies.get(STAFF_SESSION_COOKIE)?.value ?? "";
  const staffSecret = process.env.STAFF_SESSION_SECRET || "";
  let hasStaffCookie = !!staffToken;
  if (staffToken && staffSecret) {
    try {
      const sess = await verifyTokenEdge<{ exp?: number }>(staffToken, staffSecret);
      if (!sess) {
        hasStaffCookie = false; // หมดอายุ/ลายเซ็นไม่ตรง → ให้เด้งไป login แทนค้างหน้าเปล่า
      } else if (typeof sess.exp === "number" && staffSessionNeedsRenewal(sess.exp)) {
        const renewed = await signTokenEdge(
          { ...sess, exp: Math.floor(Date.now() / 1000) + STAFF_SESSION_TTL_SEC },
          staffSecret
        );
        response.cookies.set(STAFF_SESSION_COOKIE, renewed, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: STAFF_SESSION_TTL_SEC,
        });
      }
    } catch {
      // verify ที่ edge พลาด (เช่น crypto ไม่พร้อม) → ไม่ตัดสินที่นี่ ปล่อยชั้นหน้า/แอ็กชันตัดสิน
    }
  }

  const pathname = request.nextUrl.pathname;
  if (shouldRedirectToLogin(pathname, !!user || hasStaffCookie)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    const backTo = pathname + request.nextUrl.search; // ★ เก็บ query ด้วย — เด้งกลับถึงบิลใบเดิม
    loginUrl.search = "";
    // เก็บปลายทางเดิมไว้ให้ redirect กลับหลัง login สำเร็จ
    loginUrl.searchParams.set("redirect", backTo);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // ยกเว้น static assets + health (health ต้องเข้าถึงได้เสมอ)
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
