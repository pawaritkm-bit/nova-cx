import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurveyType } from "@/lib/survey/types";
import { getActiveVersionByType } from "@/lib/survey/service";
import { generateInvitationToken } from "@/lib/survey/token";
import { oaForSurveyType } from "@/lib/line/routing";
import { buildAssigneeSnapshot, type AssigneeSnapshotItem } from "@/lib/scheduling/eligibility";
import { getAppBaseUrl } from "@/lib/env";

/**
 * ส่งแบบประเมินแบบ "กดเอง" (manual send) โดยพนักงาน admin/executive
 *
 *   flow:
 *     1) ยืนยันลูกค้าอยู่ tenant นี้จริง + ยังไม่ถูกลบ (กัน cross-tenant)
 *     2) หา survey_version ที่ active ของชนิดที่เลือก (A/B/C/D) ใน tenant
 *     3) สร้าง survey_invitation (cycle_period แบบ manual + idempotency_key สุ่ม
 *        → ไม่ชน unique(customer, type, cycle) ของรอบอัตโนมัติ/ครั้งก่อน)
 *        - B → snapshot นักบัญชีผู้ดูแลปัจจุบัน ; A/C/D → []
 *     4) ถ้าลูกค้าแอด OA (มี line_user ที่ยังไม่บล็อก) → enqueue notification (push)
 *        คืน pushed=true ; ถ้าไม่มี → คืน pushed=false + survey_url ให้ copy ส่งเอง
 *
 *   ★ ไม่พึ่ง flag auto_survey_enabled — ส่งเองได้เสมอไม่ว่าสวิตช์เปิด/ปิด
 *   ★ ไม่แตะ deal-status flow — เป็นคนละ path (event-driven)
 */

type DB = SupabaseClient;

/** อายุ token invitation (30 วัน — สอดคล้อง scheduling/integration เซล) */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** error สำหรับเคสที่ผู้ใช้แก้ได้เอง (route/action แปลงเป็นข้อความสุภาพ) */
export class ManualSurveyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualSurveyError";
  }
}

export type ManualSurveyResult = {
  invitationId: string;
  /** true = push เข้า LINE OA แล้ว (ลูกค้าแอด OA) ; false = คืนลิงก์ให้ส่งเอง */
  pushed: boolean;
  /** ลิงก์เว็บเปิดฟอร์มได้ทุกเบราว์เซอร์ (สำหรับ copy กรณีไม่ push) */
  surveyUrl: string;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: string }).code === "23505"
  );
}

/** ยืนยันลูกค้าอยู่ tenant นี้ + ไม่ soft-deleted (คืน id) */
async function assertCustomerInTenant(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<string> {
  const { data, error } = await db
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    throw new ManualSurveyError("ไม่พบลูกค้าที่เลือก (หรืออยู่นอกสำนักงานของคุณ)");
  }
  return (data as { id: string }).id;
}

/** หา line_user เจ้าของที่ส่งได้ (ไม่บล็อก, ล่าสุด) ของลูกค้า — null ถ้าไม่มี/ไม่แอด OA */
async function findReachableLineUserId(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<string | null> {
  const { data } = await db
    .from("line_users")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("is_blocked", false)
    .is("deleted_at", null)
    .order("linked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? (data as { id: string }).id : null;
}

/** snapshot นักบัญชีผู้ดูแลปัจจุบัน (valid_to null) + enrich ชื่อ — สำหรับ Form B */
async function loadCurrentAssigneeSnapshot(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<AssigneeSnapshotItem[]> {
  const { data: assigns } = await db
    .from("customer_assignments")
    .select("employee_id, role")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("valid_to", null)
    .is("deleted_at", null);

  const assignments = (assigns ?? []) as { employee_id: string; role: string | null }[];
  if (assignments.length === 0) return [];

  const ids = [...new Set(assignments.map((a) => a.employee_id))];
  const { data: emps } = await db
    .from("employees")
    .select("id, first_name, nickname, position")
    .in("id", ids);

  return buildAssigneeSnapshot(
    assignments,
    (emps ?? []) as {
      id: string;
      first_name: string | null;
      nickname: string | null;
      position: string | null;
    }[]
  );
}

/**
 * cycle_period แบบ manual — รูปแบบ "manual:<YYYY-MM-DDTHH:MM>:<rand>"
 *   ใส่ random suffix กันชน unique(customer, type, cycle) เมื่อกดส่งซ้ำในนาทีเดียวกัน
 *   (manual ตั้งใจให้ส่งซ้ำได้ — จึงต้องไม่ dedup กับรอบก่อน)
 */
function manualCyclePeriod(now: Date): string {
  const minute = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const rand = randomBytes(4).toString("hex");
  return `manual:${minute}:${rand}`;
}

export async function sendManualSurvey(
  db: DB,
  tenantId: string,
  input: { customerId: string; surveyType: SurveyType },
  deps: { now?: () => Date; generateToken?: () => string } = {}
): Promise<ManualSurveyResult> {
  const now = deps.now ? deps.now() : new Date();
  const generateToken = deps.generateToken ?? generateInvitationToken;
  const { surveyType } = input;

  // 1) cross-tenant guard
  const customerId = await assertCustomerInTenant(db, tenantId, input.customerId);

  // 2) template active ของชนิดที่เลือก
  const found = await getActiveVersionByType(db, tenantId, surveyType);
  if (!found) {
    throw new ManualSurveyError(
      "ยังไม่ได้ตั้งแบบฟอร์มสำหรับชนิดนี้ (ตั้งแบบฟอร์มก่อนจึงจะส่งได้)"
    );
  }

  // 3) B → ผูกนักบัญชีผู้ดูแลปัจจุบัน ; A/C/D → ไม่ผูกบุคคล
  const assigneeSnapshot =
    surveyType === "B"
      ? await loadCurrentAssigneeSnapshot(db, tenantId, customerId)
      : [];

  const lineUserId = await findReachableLineUserId(db, tenantId, customerId);
  const token = generateToken();
  const idempotencyKey = `manual:${randomBytes(16).toString("hex")}`;

  // 4) insert invitation (ไม่ผ่าน RPC scheduling เพราะ push เป็น conditional)
  const { data, error } = await db
    .from("survey_invitations")
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      line_user_id: lineUserId,
      survey_type: surveyType,
      survey_version_id: found.version.id,
      cycle_period: manualCyclePeriod(now),
      assignee_snapshot: assigneeSnapshot,
      token,
      token_expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
      status: "pending",
      idempotency_key: idempotencyKey,
    })
    .select("id")
    .single();

  if (error) {
    // ชน unique (rare: random ซ้ำ) → แจ้งให้ลองใหม่ ไม่หลุด internal
    if (isUniqueViolation(error)) {
      throw new ManualSurveyError("ส่งไม่สำเร็จ (รายการซ้ำ) กรุณาลองใหม่อีกครั้ง");
    }
    throw new Error(error.message);
  }

  const invitationId = (data as { id: string }).id;
  const surveyUrl = `${getAppBaseUrl()}/liff/survey?token=${encodeURIComponent(token)}`;

  // 5) ลูกค้าแอด OA → enqueue notification (worker push ต่อ) ; ไม่งั้นคืนลิงก์ให้ copy
  if (lineUserId) {
    const { error: jobErr } = await db.from("job_queue").insert({
      tenant_id: tenantId,
      queue: "notification",
      payload: {
        kind: "survey_invitation",
        invitation_id: invitationId,
        survey_type: surveyType,
        oa: oaForSurveyType(surveyType),
      },
    });
    // enqueue ล้ม → ยังมี invitation อยู่ → degrade เป็นคืนลิงก์ให้ส่งเอง (ไม่ throw)
    if (!jobErr) {
      return { invitationId, pushed: true, surveyUrl };
    }
  }

  return { invitationId, pushed: false, surveyUrl };
}
