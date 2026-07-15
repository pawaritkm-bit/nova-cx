/**
 * อ่าน environment variables อย่างปลอดภัย
 * - ไม่ throw ตอน import (กัน build/health check ล้มเมื่อยังไม่ตั้ง env)
 * - ตรวจว่าครบหรือไม่ผ่าน helper เพื่อให้ health check ตอบ degraded ได้อย่างสุภาพ
 */

export type SupabaseEnv = {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
};

/** คืน config Supabase ถ้าตั้งครบ, ไม่ครบคืน null (ไม่ throw) */
export function getSupabaseEnv(): SupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) return null;

  return {
    url,
    anonKey,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/** true เมื่อมี env Supabase ครบขั้นต่ำ (url + anon key) */
export function hasSupabaseEnv(): boolean {
  return getSupabaseEnv() !== null;
}
