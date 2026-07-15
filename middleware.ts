import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/env";

/**
 * รีเฟรช session ของพนักงาน (Supabase Auth) ในทุก request
 * - ถ้ายังไม่ตั้ง env → ปล่อยผ่าน ไม่ crash
 * - M1: ยังไม่บังคับ redirect ไป /login (ยังไม่มีหน้า auth) — วางฐาน session ก่อน
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

  // จำเป็นต้องเรียกเพื่อ refresh token ที่หมดอายุ
  await supabase.auth.getUser();

  return response;
}

export const config = {
  // ยกเว้น static assets + health (health ต้องเข้าถึงได้เสมอ)
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
