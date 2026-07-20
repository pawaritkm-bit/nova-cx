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

/**
 * LIFF ID สำหรับหน้า "ลงทะเบียนนักบัญชีผ่าน QR" (/reg/staff)
 *   ลำดับ: LINE_STAFF_REG_LIFF_ID (dedicated LIFF ที่ endpoint ชี้ /reg/staff)
 *          → fallback LINE_CARE_LIFF_ID (ถ้ายังไม่แยก LIFF)
 *   ⚠️ ต้องเป็น LIFF บน LINE Login channel ที่อยู่ "provider เดียวกับ Care OA"
 *      ไม่งั้น userId จาก login จะไม่ตรงกับ userId ในกลุ่มแชต (ดู provider note)
 */
export function getStaffRegLiffId(): string | undefined {
  return process.env.LINE_STAFF_REG_LIFF_ID || getLiffId("care") || undefined;
}

/**
 * channel id ของ LINE Login channel ที่ออก idToken ให้หน้า reg (ใช้ verify idToken
 * ฝั่ง server เป็น `client_id`). ลำดับ:
 *   LINE_LOGIN_CHANNEL_ID → ดึงจาก prefix ของ staff-reg LIFF id (`<channelId>-<random>`)
 * คืน undefined ถ้าเดาไม่ได้ → route จะตอบ 503 (verify idToken ไม่ได้ = ปิดฟีเจอร์)
 */
export function getLineLoginChannelId(): string | undefined {
  const explicit = process.env.LINE_LOGIN_CHANNEL_ID;
  if (explicit) return explicit;
  const liffId = getStaffRegLiffId();
  const prefix = liffId?.split("-")[0]?.trim();
  return prefix || undefined;
}

/**
 * รหัสลงทะเบียนนักบัญชี (secret) — ผู้ลงทะเบียนต้องกรอกให้ตรงถึงจะผูก LINE↔พนักงานได้
 * กันลูกค้า/คนนอกในกลุ่มแอบลงทะเบียนเป็นนักบัญชี
 * คืน undefined ถ้ายังไม่ตั้ง → ปิดฟีเจอร์ทั้งหมด (fail-safe: route ตอบ 503)
 */
export function getStaffRegisterCode(): string | undefined {
  return process.env.STAFF_REGISTER_CODE || undefined;
}

export type LineOaCredentials = {
  /** channel id (optional — ใช้เฉพาะบางการเรียก) */
  channelId?: string;
  /** channel secret — ใช้ verify x-line-signature (HMAC) ของ webhook */
  channelSecret: string;
  /** long-lived channel access token — ใช้ยิง Messaging API (push/reply) */
  channelAccessToken: string;
};

/**
 * credential ของ OA (Care/Sale) จาก env — คืน null ถ้ายังไม่ครบ
 * (ต้องมีทั้ง channel secret + access token ถึงจะยิง LINE ได้จริง)
 * secret มาจาก env เท่านั้น (C-14) ไม่ฝังในโค้ด
 */
export function getLineOaCredentials(oa: LineOa): LineOaCredentials | null {
  const prefix = oa === "care" ? "LINE_CARE" : "LINE_SALE";
  const channelSecret = process.env[`${prefix}_CHANNEL_SECRET`];
  const channelAccessToken = process.env[`${prefix}_CHANNEL_ACCESS_TOKEN`];

  if (!channelSecret || !channelAccessToken) return null;

  return {
    channelId: process.env[`${prefix}_CHANNEL_ID`] || undefined,
    channelSecret,
    channelAccessToken,
  };
}

/**
 * channel secret ของ OA — สำหรับ verify webhook signature โดยเฉพาะ
 * (แยกออกมาเพราะ webhook ต้อง verify ได้แม้ยังไม่ได้ตั้ง access token)
 */
export function getLineChannelSecret(oa: LineOa): string | undefined {
  const prefix = oa === "care" ? "LINE_CARE" : "LINE_SALE";
  return process.env[`${prefix}_CHANNEL_SECRET`] || undefined;
}

/** true เมื่อ OA นั้นตั้ง credential ครบ (พร้อมยิง Messaging API) */
export function hasLineOaCredentials(oa: LineOa): boolean {
  return getLineOaCredentials(oa) !== null;
}

/**
 * group id ของ "กลุ่ม LINE สำนักงาน" (fallback ระดับ env) — ใช้เมื่อ invitation
 * ยังไม่มี group id ผูกมาเอง (dev/เฟสแรกที่ยังไม่เก็บ group ต่อลูกค้า)
 * TODO(chunk ถัดไป): เก็บ group id ต่อลูกค้า/สำนักงานใน DB แทน env กลาง
 */
export function getOfficeGroupId(): string | undefined {
  return process.env.LINE_CARE_OFFICE_GROUP_ID || undefined;
}

/**
 * tenant override สำหรับ LINE webhook (multi-tenant future) — ยังไม่ตั้ง = undefined
 * เฟสแรก (1 tenant) webhook จะ resolve tenant จากตาราง tenants เอง
 */
export function getLineTenantId(): string | undefined {
  return process.env.LINE_TENANT_ID || undefined;
}

/**
 * base URL ของแอป (ใช้ประกอบ survey_url ลิงก์เว็บที่เปิดในเบราว์เซอร์ไหนก็ได้)
 *   ลำดับ: NEXT_PUBLIC_APP_URL → https://${VERCEL_URL} → fallback prod
 *   ตัด trailing slash ออกเสมอ เพื่อไม่ให้เกิด // ตอนต่อ path
 */
export function getAppBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
  return "https://nova-cx.vercel.app";
}
