import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { shouldRedirectToLogin } from "@/lib/auth/guard";

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

  const pathname = request.nextUrl.pathname;
  if (shouldRedirectToLogin(pathname, !!user)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    // เก็บปลายทางเดิมไว้ให้ redirect กลับหลัง login สำเร็จ
    loginUrl.searchParams.set("redirect", pathname);
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
