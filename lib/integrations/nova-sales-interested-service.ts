import { getNovaSalesApiKey, getNovaSalesBaseUrl } from "@/lib/env";
import { AUTH_HEADER } from "@/lib/integrations/nova-sales";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * NOVA-CX → NOVA Sales: ส่งสัญญาณ "ลูกค้าสนใจบริการเสริม" จากแบบประเมิน Form A
 *
 * เมื่อลูกค้าเลือกบริการที่สนใจ (≥1) ใน Form A → ยิง POST ต่อบริการไปสร้าง
 * NBS recommendation ที่ NOVA Sales อัตโนมัติ
 *
 * หลักการ:
 *   ★ best-effort: ไม่ throw, ไม่กระทบ flow แบบประเมิน (try/catch + log)
 *   ★ idempotent ฝั่ง Sales (ยิงซ้ำ = update ไม่สร้างซ้ำ)
 *   ★ ยิงเฉพาะ service code ที่อยู่ในลิสต์ 22 ตัวของ Sales เท่านั้น
 *   ★ PDPA: ไม่ log ชื่อ/เลขภาษี/ตัวชี้ตัวตนลูกค้า
 */

const ENDPOINT_PATH = "/api/integrations/nova-cx/interested-service";
const OUTBOUND_TIMEOUT_MS = 8_000;

/** 22 service codes ที่ NOVA Sales รับ — ห้ามส่ง code นอกลิสต์นี้ */
const VALID_SALES_CODES = new Set([
  "reg_company",
  "reg_partnership",
  "acct_monthly_personal",
  "acct_monthly_corporate",
  "personal_tax_annual",
  "vat_registration",
  "specific_business_tax",
  "social_security",
  "tax_planning",
  "internal_accounting",
  "company_closure",
  "change_director",
  "change_shareholder",
  "change_address",
  "legal_general",
  "visa",
  "audit_closing",
  "cfo",
  "stock_audit",
  "system_setup",
  "due_diligence",
  "holding_company",
]);

/**
 * ดึงรายการบริการที่ลูกค้าเลือกจาก answers ของ Form A
 * คืนเฉพาะ code ที่อยู่ในลิสต์ Sales — ตัวเลือกที่ map ไม่ได้จะถูก log + ข้าม
 */
export function extractMappableServices(
  answers: Record<string, unknown>
): string[] {
  const raw = answers.a_services;
  if (!Array.isArray(raw)) return [];

  const mapped: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v) continue;
    if (v === "none") continue;
    if (VALID_SALES_CODES.has(v)) {
      mapped.push(v);
    } else {
      console.info(
        `[cx-interested-service] skip unmappable option: ${v}`
      );
    }
  }
  return mapped;
}

export type PushInterestedServiceArgs = {
  externalRef: string;
  customerCode: string | null;
  serviceCode: string;
  note: string;
  surveyRef: string;
};

type PushResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
};

async function pushOne(args: PushInterestedServiceArgs): Promise<PushResult> {
  const baseUrl = getNovaSalesBaseUrl();
  if (!baseUrl) {
    console.info("[cx-interested-service] pending — NOVA_SALES_BASE_URL not set, skip");
    return { ok: true, skipped: true };
  }

  const apiKey = getNovaSalesApiKey();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers[AUTH_HEADER] = apiKey;

  const body = JSON.stringify({
    external_customer_id: args.externalRef,
    interested_service_code: args.serviceCode,
    note: args.note,
    survey_ref: args.surveyRef,
  });

  const url = `${baseUrl}${ENDPOINT_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[cx-interested-service] push failed code=${args.serviceCode} status=${res.status}`
      );
      return { ok: false, error: `status_${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    console.warn(
      `[cx-interested-service] push error code=${args.serviceCode} name=${name}`
    );
    return { ok: false, error: name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fire-and-forget: ดึง external_ref ของลูกค้า + ยิง POST ต่อบริการที่สนใจ
 * เรียกจาก survey submit route หลัง persist สำเร็จ (Form A เท่านั้น)
 */
export async function fireInterestedServiceSignals(
  db: SupabaseClient,
  args: {
    customerId: string;
    services: string[];
    surveyRef: string;
    answers: Record<string, unknown>;
  }
): Promise<void> {
  try {
    const { data: cust } = await db
      .from("customers")
      .select("external_ref, customer_code")
      .eq("id", args.customerId)
      .maybeSingle();

    if (!cust?.external_ref) {
      console.info(
        "[cx-interested-service] skip — customer has no external_ref (not from Sales)"
      );
      return;
    }

    const note = buildNote(args.answers);

    for (const code of args.services) {
      await pushOne({
        externalRef: cust.external_ref as string,
        customerCode: (cust.customer_code as string) ?? null,
        serviceCode: code,
        note,
        surveyRef: args.surveyRef,
      });
    }
  } catch (e) {
    console.warn(
      "[cx-interested-service] fire error:",
      e instanceof Error ? e.message : "unknown"
    );
  }
}

function buildNote(answers: Record<string, unknown>): string {
  const parts: string[] = [];
  const nps = answers.nps;
  if (typeof nps === "number") parts.push(`NPS=${nps}`);
  const cont = answers.continue;
  if (typeof cont === "string") parts.push(`continue=${cont}`);
  return parts.length > 0
    ? `CX survey: ${parts.join(", ")}`
    : "CX survey signal";
}
