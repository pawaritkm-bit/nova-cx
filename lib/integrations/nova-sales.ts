import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import type { SurveyType } from "@/lib/survey/types";

/**
 * NOVA Sales → NOVA-CX Integration contract
 *   - Auth: header `x-api-key` เทียบกับ NOVA_SALES_API_KEY (อ่านจาก env เท่านั้น)
 *   - Payload validate ด้วย Zod + idempotent (external id + idempotency key)
 *   - เมื่อดีลปิด Won/Lost → enqueue แบบประเมินเซล (C/D) ผ่าน OA Sale
 */

const HEADER_NAME = "x-api-key";

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

/** เทียบ secret แบบ constant-time (กัน timing attack) */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * ตรวจ API key จาก header เทียบ env
 *   - env ไม่ตั้ง → 503 (ปิด endpoint ไว้ ไม่เปิดโล่ง)
 *   - key ไม่ตรง/ไม่มี → 401
 */
export function checkNovaSalesAuth(
  headers: Headers,
  envKey: string | undefined
): AuthResult {
  if (!envKey) {
    return {
      ok: false,
      status: 503,
      error: "integration ยังไม่ถูกตั้งค่า (NOVA_SALES_API_KEY)",
    };
  }
  const provided = headers.get(HEADER_NAME) ?? "";
  if (!provided || !constantTimeEqual(provided, envKey)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

export const AUTH_HEADER = HEADER_NAME;

/**
 * ตรวจว่า tenant_id ใน payload ตรงกับ tenant ที่ผูกกับ API key (Reviewer 🔴#2)
 *   - allowedTenant ตั้งไว้ → ต้องตรงเป๊ะ (คืน false = reject)
 *   - allowedTenant ไม่ตั้ง (dev) → ผ่าน (ควรตั้งใน prod)
 */
export function checkTenantAllowed(
  tenantId: string,
  allowedTenant: string | undefined
): boolean {
  if (!allowedTenant) return true;
  return tenantId === allowedTenant;
}

// --------------------------------------------------------------------------
// Zod payload schemas
// --------------------------------------------------------------------------

const uuid = z.string().uuid();

const contactSchema = z
  .object({
    name: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
  })
  .optional();

/** POST /api/integrations/nova-sales/customer — สร้าง/อัปเดตลูกค้า (+lead) */
export const customerUpsertSchema = z.object({
  tenant_id: uuid,
  /** id ลูกค้าฝั่ง NOVA Sales (ใช้ทำ idempotency ถ้าไม่มี customer_code) */
  external_customer_id: z.string().optional(),
  customer_code: z.string().optional(),
  name: z.string().min(1, "ต้องมีชื่อลูกค้า"),
  business_name: z.string().optional(),
  service_start_date: z.string().optional(),
  status: z.enum(["active", "cancelled", "prospect"]).optional(),
  contact: contactSchema,
  lead: z
    .object({
      external_lead_id: z.string().optional(),
      name: z.string().optional(),
      source: z.string().optional(),
      owner_employee_id: uuid.optional(),
    })
    .optional(),
});

export type CustomerUpsertPayload = z.infer<typeof customerUpsertSchema>;

/** POST /api/integrations/nova-sales/deal-status — อัปเดตสถานะดีล (Won/Lost/Open) */
export const dealStatusSchema = z.object({
  tenant_id: uuid,
  /** id ดีลฝั่ง NOVA Sales — ใช้ทำ idempotency (กันสร้างดีลซ้ำ) */
  external_deal_id: z.string().min(1, "ต้องมี external_deal_id"),
  /** ผูกลูกค้า: อย่างใดอย่างหนึ่ง (id ภายใน หรือ customer_code) */
  customer_id: uuid.optional(),
  customer_code: z.string().optional(),
  external_lead_id: z.string().optional(),
  /** เซลผู้ถูกประเมิน: ส่ง uuid ภายในได้ (sales_employee_id) หรือส่งชื่อ (sales_employee_name)
   *  แล้วให้ NOVA-CX resolve เป็น employee_id เอง — roster ฝั่ง NOVA Sales เป็นชื่อ ไม่มี uuid */
  sales_employee_id: uuid.optional(),
  sales_employee_name: z.string().optional(),
  stage: z.string().optional(),
  amount: z.number().nonnegative().optional(),
  status: z.enum(["open", "won", "lost"]),
  closed_at: z.string().optional(),
});

export type DealStatusPayload = z.infer<typeof dealStatusSchema>;

/** สถานะดีล → ชนิดแบบประเมินเซล (won=C ขายได้, lost=D ขายไม่ได้, open=ไม่ส่ง) */
export function dealStatusToSurveyType(
  status: DealStatusPayload["status"]
): "C" | "D" | null {
  if (status === "won") return "C";
  if (status === "lost") return "D";
  return null;
}

/** idempotency key มาตรฐานสำหรับ invitation ที่มาจากดีล (กันยิงซ้ำ) */
export function dealInvitationIdempotencyKey(
  externalDealId: string,
  surveyType: SurveyType
): string {
  return `nova-sales:deal:${externalDealId}:${surveyType}`;
}

/** cycle_period ของ invitation ที่มาจากดีล (1 ครั้ง/ดีล — FR-SC-02/05) */
export function dealCyclePeriod(externalDealId: string): string {
  return `deal:${externalDealId}`;
}
