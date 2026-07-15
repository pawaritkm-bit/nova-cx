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

/**
 * secret สำหรับ NOVA Sales Integration API (ยิงเข้ามาเมื่อเปิดลูกค้า/ดีล)
 * คืน undefined ถ้ายังไม่ตั้ง — route จะตอบ 503 (ไม่เปิด endpoint โล่ง)
 */
export function getNovaSalesApiKey(): string | undefined {
  return process.env.NOVA_SALES_API_KEY || undefined;
}

/**
 * tenant ที่ผูกกับ NOVA_SALES_API_KEY (allowlist) — ถ้าตั้งไว้ integration จะรับ
 * เฉพาะ payload.tenant_id นี้เท่านั้น (กัน key เดียวเขียนข้าม tenant — Reviewer 🔴#2)
 * ยังไม่ตั้ง = undefined (dev) แต่ควรตั้งใน prod
 */
export function getNovaSalesTenantId(): string | undefined {
  return process.env.NOVA_SALES_TENANT_ID || undefined;
}

export type LineOa = "care" | "sale";

/**
 * LIFF ID ต่อ OA (Care = A/B, Sale = C/D) — อ่านจาก env
 * คืน undefined ถ้ายังไม่ตั้ง → LIFF หน้าเว็บ degrade เป็น dev mode (ไม่ crash)
 */
export function getLiffId(oa: LineOa): string | undefined {
  const key = oa === "care" ? "LINE_CARE_LIFF_ID" : "LINE_SALE_LIFF_ID";
  return process.env[key] || undefined;
}

/** true เมื่อยังไม่ตั้ง LIFF ID ทั้งสอง OA → หน้า LIFF ทำงานโหมด dev */
export function isLineDevMode(): boolean {
  return !getLiffId("care") && !getLiffId("sale");
}
