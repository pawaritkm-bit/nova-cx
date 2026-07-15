import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "@/lib/env";

/**
 * Supabase client ฝั่ง server (Server Components / Route Handlers)
 * - ผูกกับ cookie ของ request เพื่อคง session พนักงาน (RBAC + RLS ทำงานตาม auth.uid())
 * - Next.js 15: cookies() เป็น async
 */
export async function createClient() {
  const env = getSupabaseEnv();
  if (!env) {
    throw new Error(
      "ยังไม่ได้ตั้งค่า NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY"
    );
  }

  const cookieStore = await cookies();

  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options: CookieOptions }[]
      ) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // เรียกจาก Server Component (set cookie ไม่ได้) — ปล่อยผ่าน
          // middleware จะ refresh session ให้เอง
        }
      },
    },
  });
}

/**
 * Service-role client (ข้าม RLS) — ใช้เฉพาะงานเบื้องหลัง เช่น worker/cron/seed
 * ห้ามใช้ตอบ request ลูกค้า/พนักงานโดยตรง
 */
export function createServiceRoleClient() {
  const env = getSupabaseEnv();
  if (!env || !env.serviceRoleKey) {
    throw new Error("ยังไม่ได้ตั้งค่า SUPABASE_SERVICE_ROLE_KEY");
  }

  return createServerClient(env.url, env.serviceRoleKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll() {
        /* service-role ไม่ผูก cookie */
      },
    },
  });
}
