/**
 * รวบรวม "สถานะการเชื่อมต่อระบบ" แบบ boolean สำหรับหน้า /settings
 *
 * ★ กติกาความปลอดภัย: คืนได้เฉพาะ "ตั้งค่าแล้ว/ยังไม่ตั้ง" (configured: boolean)
 *   และค่าที่ไม่ใช่ความลับ (ชื่อ provider/model) เท่านั้น
 *   ห้ามคืน/แสดงค่า secret จริง (API key / channel secret / access token) เด็ดขาด
 *   — เช็คผ่าน helper ใน lib/env.ts ที่คืน boolean/ค่าที่เปิดเผยได้เท่านั้น
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  hasSupabaseEnv,
  getSupabaseEnv,
  hasLineOaCredentials,
  getLiffId,
  isLineDevMode,
  getNovaSalesApiKey,
  getNovaSalesTenantId,
} from "@/lib/env";
import { isAIConfigured } from "@/lib/ai/provider";

export type IntegrationStatus = {
  supabase: {
    /** มี url + anon key ครบ */
    configured: boolean;
    /** มี service-role key (ใช้ทำงานเบื้องหลัง/อ่านข้าม RLS) */
    serviceRole: boolean;
  };
  ai: {
    /** พร้อมเรียก AI จริง (มี provider + key) */
    configured: boolean;
    /** ชื่อ provider (config ไม่ใช่ secret) */
    provider: string;
    /** ชื่อโมเดล (config ไม่ใช่ secret) */
    model: string;
  };
  lineCare: { credentials: boolean; liff: boolean };
  lineSale: { credentials: boolean; liff: boolean };
  /** true = ยังไม่ตั้ง LIFF ทั้งสอง OA → หน้า LIFF ทำงานโหมด dev */
  lineDevMode: boolean;
  novaSales: {
    /** ตั้ง secret รับ integration แล้ว (เปิด endpoint) */
    apiKey: boolean;
    /** ผูก tenant กับ key (allowlist กัน key เขียนข้าม tenant) */
    tenantBound: boolean;
  };
};

/**
 * อ่านสถานะ integration จาก env (ไม่แตะ DB) — คืนเฉพาะ boolean/ค่าที่เปิดเผยได้
 * provider/model ของ AI เป็น config (ไม่ใช่ secret) จึงแสดงได้
 */
export function collectIntegrationStatus(): IntegrationStatus {
  return {
    supabase: {
      configured: hasSupabaseEnv(),
      serviceRole: !!getSupabaseEnv()?.serviceRoleKey,
    },
    ai: {
      configured: isAIConfigured(),
      provider: (process.env.AI_PROVIDER || "openai").toLowerCase(),
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    },
    lineCare: {
      credentials: hasLineOaCredentials("care"),
      liff: !!getLiffId("care"),
    },
    lineSale: {
      credentials: hasLineOaCredentials("sale"),
      liff: !!getLiffId("sale"),
    },
    lineDevMode: isLineDevMode(),
    novaSales: {
      apiKey: !!getNovaSalesApiKey(),
      tenantBound: !!getNovaSalesTenantId(),
    },
  };
}

export type CronHealthView = {
  jobName: string;
  status: string;
  lastRunAt: string | null;
};

export type SettingsSnapshot = {
  tenantName: string | null;
  employeeCount: number;
  customerCount: number;
  cronHealth: CronHealthView[];
  /** true = อ่าน DB ไม่สำเร็จ (แสดง degrade แต่หน้าไม่ล้ม) */
  dbError: boolean;
};

/** คาดหวัง service-role client (ข้าม RLS) — page เป็นผู้สร้างและ scope ด้วย tenant */
type DB = SupabaseClient;

/**
 * อ่านสถานะจาก DB: ชื่อ tenant, จำนวนพนักงาน/ลูกค้า (นับคร่าว), cron health
 * scope ด้วย tenantId จาก session เสมอ; อ่านพังก็ degrade (dbError=true) ไม่ throw
 */
export async function getSettingsSnapshot(
  db: DB,
  tenantId: string
): Promise<SettingsSnapshot> {
  try {
    const [tenantRes, empRes, custRes, cronRes] = await Promise.all([
      db.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
      db
        .from("employees")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .is("deleted_at", null),
      db
        .from("customers")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .is("deleted_at", null),
      db
        .from("cron_health")
        .select("job_name, status, last_run_at")
        .order("job_name", { ascending: true }),
    ]);

    const cronHealth: CronHealthView[] = (
      (cronRes.data ?? []) as {
        job_name: string;
        status: string;
        last_run_at: string | null;
      }[]
    ).map((r) => ({
      jobName: r.job_name,
      status: r.status,
      lastRunAt: r.last_run_at,
    }));

    return {
      tenantName: (tenantRes.data as { name?: string } | null)?.name ?? null,
      employeeCount: empRes.count ?? 0,
      customerCount: custRes.count ?? 0,
      cronHealth,
      dbError: false,
    };
  } catch {
    return {
      tenantName: null,
      employeeCount: 0,
      customerCount: 0,
      cronHealth: [],
      dbError: true,
    };
  }
}
