import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { STAFF_SESSION_COOKIE } from "@/lib/staff/cookie";

export const dynamic = "force-dynamic";

/**
 * ออกจากระบบ — เคลียร์ session cookie แล้วพากลับหน้า /login
 * ใช้ผ่าน <form method="post" action="/auth/logout"> (ไม่ต้องพึ่ง JS)
 * 303 → browser follow ด้วย GET ไป /login
 * รองรับทั้ง admin (Supabase Auth) และ staff (LINE session cookie)
 */
export async function POST(request: Request) {
  if (getSupabaseEnv()) {
    try {
      const supabase = await createClient();
      await supabase.auth.signOut();
    } catch {
      // ถอน session ไม่สำเร็จ (เช่น env/DB) → ยังพากลับ login ตามปกติ
    }
  }
  const res = NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  // เคลียร์ staff session (LINE login) ด้วยเสมอ
  res.cookies.set(STAFF_SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
