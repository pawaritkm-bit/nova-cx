import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/env";

/**
 * Supabase client ฝั่ง browser (พนักงาน — Supabase Auth)
 * ใช้ใน Client Components เท่านั้น
 */
export function createClient() {
  const env = getSupabaseEnv();
  if (!env) {
    throw new Error(
      "ยังไม่ได้ตั้งค่า NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY"
    );
  }
  return createBrowserClient(env.url, env.anonKey);
}
