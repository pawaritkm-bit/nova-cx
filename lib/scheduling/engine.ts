import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurveyType } from "@/lib/survey/types";
import { getActiveVersionByType } from "@/lib/survey/service";
import { generateInvitationToken } from "@/lib/survey/token";
import { oaForSurveyType } from "@/lib/line/routing";
import {
  accountantCyclePeriod,
  buildAssigneeSnapshot,
  customerBlockState,
  isCustomerServiceActive,
  officeCycleDue,
  schedulingIdempotencyKey,
  type AssigneeSnapshotItem,
} from "./eligibility";

/**
 * Scheduling engine (DB) — ถูกเรียกจาก cron scan-invitations รายวัน
 *   สแกนลูกค้า active → เช็ค eligibility (A ราย 3 เดือน / B ต้นเดือน) →
 *   สร้าง survey_invitation แบบ idempotent + enqueue job_queue(notification) ให้
 *   notification worker (chunk 3) ส่งต่อ (scan ไม่ส่ง LINE เอง)
 *
 * degrade อย่างสุภาพ: ไม่พบ template active ของชนิดนั้น → ข้าม (นับ noTemplate)
 * inject deps (now/getActiveVersion/generateToken) เพื่อ test ได้โดยไม่พึ่งเวลา/สุ่มจริง
 */

type DB = SupabaseClient;

/** อายุ token invitation (30 วัน — สอดคล้อง integration เซล) */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** ขนาดต่อหน้าเวลาวนดึงลูกค้า (pagination) — วนจนหมด ไม่ตัดตายที่หน้าเดียว (H1) */
const CUSTOMER_PAGE_SIZE = 500;

export type SchedulingDeps = {
  db: DB;
  now?: () => Date;
  /** ดึง template+version ที่ active ตามชนิด — default: survey/service */
  getActiveVersion?: typeof getActiveVersionByType;
  /** สร้าง token — default: survey/token */
  generateToken?: () => string;
  /** ขนาดต่อหน้าเวลาวนดึงลูกค้า (default 500) — ปรับได้เพื่อ test pagination */
  pageSize?: number;
};

export type ScanSummary = {
  scanned: number; // ลูกค้าที่พิจารณา
  created: number; // invitation สร้างใหม่ + enqueue
  existed: number; // มีอยู่แล้ว (idempotent skip)
  skipped: number; // ไม่เข้าเงื่อนไข/หยุด (ไม่ถึงรอบ, ยกเลิก, บล็อก ฯลฯ)
  noTemplate: number; // ยังไม่ตั้ง template ชนิดนั้น
  failed: number; // ลูกค้าที่ประมวลผลพัง (isolate ไว้ ไม่ล้มทั้ง batch — M1)
};

export type RunSchedulingSummary = {
  office: ScanSummary;
  accountant: ScanSummary;
  skippedAll: boolean;
  reason?: string;
};

function emptySummary(): ScanSummary {
  return { scanned: 0, created: 0, existed: 0, skipped: 0, noTemplate: 0, failed: 0 };
}

type CustomerRow = {
  id: string;
  tenant_id: string;
  service_start_date: string | null;
  status: string;
  deleted_at: string | null;
};

// ---------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------

/**
 * ลูกค้าที่ active + ไม่ถูกลบ (candidate สำหรับ A/B)
 *
 * H1 — batch starvation: วนดึงเป็นชุดจนหมดด้วย order("id") + range(offset..)
 *   แทน limit(500) เดี่ยว ๆ ที่ตัดลูกค้ารายที่ 501+ ทิ้งถาวร (idempotency
 *   ทำให้ค้างตลอดไป). เรียงตาม id ให้ผลคงที่/ไม่ข้าม/ไม่ซ้ำระหว่างหน้า
 */
async function loadActiveCustomers(db: DB, pageSize: number): Promise<CustomerRow[]> {
  const all: CustomerRow[] = [];
  let offset = 0;

  // วนจนหน้าที่ได้น้อยกว่า pageSize = หมดแล้ว
  for (;;) {
    const { data, error } = await db
      .from("customers")
      .select("id, tenant_id, service_start_date, status, deleted_at")
      .eq("status", "active")
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message ?? "load_customers_failed");

    const rows = (data ?? []) as CustomerRow[];
    all.push(...rows);

    if (rows.length < pageSize) break; // หน้าไม่เต็ม → หมด
    offset += pageSize;
  }

  return all;
}

/** true ถ้ามี invitation ตาม idempotency key อยู่แล้ว (idempotent guard ชั้นแรก) */
async function invitationExists(
  db: DB,
  tenantId: string,
  idempotencyKey: string
): Promise<boolean> {
  const { data } = await db
    .from("survey_invitations")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  return !!data;
}

/** รายการบัญชี LINE ของลูกค้า (ใช้ตรวจ block + เลือกปลายทางเจ้าของ) */
async function loadLineUsers(
  db: DB,
  tenantId: string,
  customerId: string
): Promise<{ id: string; is_blocked: boolean; linked_at: string | null }[]> {
  const { data } = await db
    .from("line_users")
    .select("id, is_blocked, linked_at")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .is("deleted_at", null);
  return (data ?? []) as {
    id: string;
    is_blocked: boolean;
    linked_at: string | null;
  }[];
}

/** เลือก line_user เจ้าของที่ส่งได้ (ไม่บล็อก, ล่าสุด) — คืน null ถ้าไม่มี */
function pickReachableLineUserId(
  users: { id: string; is_blocked: boolean; linked_at: string | null }[]
): string | null {
  const reachable = users
    .filter((u) => !u.is_blocked)
    .sort(
      (a, b) =>
        new Date(b.linked_at ?? 0).getTime() - new Date(a.linked_at ?? 0).getTime()
    );
  return reachable[0]?.id ?? null;
}

/** snapshot ผู้ดูแลปัจจุบันของลูกค้า (valid_to null) + enrich ชื่อจาก employees */
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

// ---------------------------------------------------------------------
// สร้าง invitation + enqueue notification (idempotent)
// ---------------------------------------------------------------------

type CreateArgs = {
  db: DB;
  tenantId: string;
  customerId: string;
  surveyType: SurveyType;
  cyclePeriod: string;
  versionId: string;
  lineUserId: string | null;
  assigneeSnapshot: AssigneeSnapshotItem[];
  idempotencyKey: string;
  token: string;
  now: Date;
};

/**
 * insert invitation + enqueue notification job — atomic (H2)
 *
 * เรียก RPC create_scheduled_invitation (SECURITY DEFINER, migration 0026):
 *   insert survey_invitation + enqueue job_queue(notification) "ใน transaction เดียว"
 *   → ถ้า enqueue ล้ม invitation จะถูก rollback ด้วย (ไม่ค้างแบบ enqueue หาย)
 *   idempotent: on conflict (tenant_id, idempotency_key) → คืน created=false ไม่ enqueue ซ้ำ
 *
 * คืน "created" | "existed"
 */
async function createInvitationAndEnqueue(
  args: CreateArgs
): Promise<"created" | "existed"> {
  const { db, surveyType, now } = args;

  const { data, error } = await db.rpc("create_scheduled_invitation", {
    p_tenant_id: args.tenantId,
    p_customer_id: args.customerId,
    p_line_user_id: args.lineUserId,
    p_survey_type: surveyType,
    p_survey_version_id: args.versionId,
    p_cycle_period: args.cyclePeriod,
    p_assignee_snapshot: args.assigneeSnapshot,
    p_token: args.token,
    p_token_expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
    p_idempotency_key: args.idempotencyKey,
    p_oa: oaForSurveyType(surveyType),
  });

  if (error) {
    throw new Error(error.message ?? "create_scheduled_invitation_failed");
  }

  const created = (data as { created?: boolean } | null)?.created === true;
  return created ? "created" : "existed";
}

// ---------------------------------------------------------------------
// A — สแกนแบบประเมินสำนักงาน (ราย 3 เดือน → กลุ่ม LINE / OA Care)
// ---------------------------------------------------------------------

async function scanOffice(
  deps: Required<Pick<SchedulingDeps, "getActiveVersion" | "generateToken">> & {
    db: DB;
    now: Date;
  },
  customers: CustomerRow[]
): Promise<ScanSummary> {
  const { db, now, getActiveVersion, generateToken } = deps;
  const summary = emptySummary();

  for (const c of customers) {
    summary.scanned += 1;

    // M1 — isolate ต่อลูกค้า: 1 รายพังไม่ล้มทั้ง batch (นับ failed แล้ว continue)
    try {
      // stop: ยกเลิกบริการ/ถูกลบ
      if (!isCustomerServiceActive(c.status, c.deleted_at)) {
        summary.skipped += 1;
        continue;
      }

      const cycle = officeCycleDue(c.service_start_date, now);
      if (!cycle.due) {
        summary.skipped += 1;
        continue;
      }

      const idempotencyKey = schedulingIdempotencyKey(c.id, "A", cycle.cyclePeriod);
      if (await invitationExists(db, c.tenant_id, idempotencyKey)) {
        summary.existed += 1; // สร้าง/ประเมินรอบนี้แล้ว → หยุด (FR-SC-05)
        continue;
      }

      const found = await getActiveVersion(db, c.tenant_id, "A");
      if (!found) {
        summary.noTemplate += 1;
        continue;
      }

      // M2 — A ส่งเข้า "กลุ่ม" (channelForSurveyType("A")=group) ไม่ใช่ 1:1
      //   notification worker route กลุ่มด้วย group_id/office group เท่านั้น
      //   (ไม่อ่าน line_user_id) → ไม่ set line_user_id เพื่อกันเข้าใจผิดว่าจะยิงส่วนบุคคล
      //   (FR-SC-01: A = ประเมินภาพรวมสำนักงานเข้ากลุ่ม LINE)
      const outcome = await createInvitationAndEnqueue({
        db,
        tenantId: c.tenant_id,
        customerId: c.id,
        surveyType: "A",
        cyclePeriod: cycle.cyclePeriod,
        versionId: found.version.id,
        lineUserId: null,
        assigneeSnapshot: [], // A = ประเมินภาพรวมสำนักงาน (ไม่ผูกรายบุคคล)
        idempotencyKey,
        token: generateToken(),
        now,
      });
      if (outcome === "created") summary.created += 1;
      else summary.existed += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------
// B — สแกนแบบประเมินนักบัญชี (รายเดือน → แชตส่วนตัว / OA Care)
// ---------------------------------------------------------------------

async function scanAccountant(
  deps: Required<Pick<SchedulingDeps, "getActiveVersion" | "generateToken">> & {
    db: DB;
    now: Date;
  },
  customers: CustomerRow[]
): Promise<ScanSummary> {
  const { db, now, getActiveVersion, generateToken } = deps;
  const summary = emptySummary();
  const cyclePeriod = accountantCyclePeriod(now);

  for (const c of customers) {
    summary.scanned += 1;

    // M1 — isolate ต่อลูกค้า: 1 รายพังไม่ล้มทั้ง batch (นับ failed แล้ว continue)
    try {
      // stop: ยกเลิกบริการ/ถูกลบ
      if (!isCustomerServiceActive(c.status, c.deleted_at)) {
        summary.skipped += 1;
        continue;
      }

      // ต้องมีผู้ดูแลปัจจุบัน (snapshot ณ ตอน trigger)
      const snapshot = await loadCurrentAssigneeSnapshot(db, c.tenant_id, c.id);
      if (snapshot.length === 0) {
        summary.skipped += 1; // ไม่มีผู้ดูแล → ยังไม่ต้องประเมินนักบัญชี
        continue;
      }

      const idempotencyKey = schedulingIdempotencyKey(c.id, "B", cyclePeriod);
      if (await invitationExists(db, c.tenant_id, idempotencyKey)) {
        summary.existed += 1;
        continue;
      }

      // B ส่งแชตส่วนตัว — stop เมื่อบล็อก OA ทั้งหมด
      const lineUsers = await loadLineUsers(db, c.tenant_id, c.id);
      if (customerBlockState(lineUsers) === "blocked") {
        summary.skipped += 1;
        continue;
      }

      const found = await getActiveVersion(db, c.tenant_id, "B");
      if (!found) {
        summary.noTemplate += 1;
        continue;
      }

      const outcome = await createInvitationAndEnqueue({
        db,
        tenantId: c.tenant_id,
        customerId: c.id,
        surveyType: "B",
        cyclePeriod,
        versionId: found.version.id,
        lineUserId: pickReachableLineUserId(lineUsers),
        assigneeSnapshot: snapshot,
        idempotencyKey,
        token: generateToken(),
        now,
      });
      if (outcome === "created") summary.created += 1;
      else summary.existed += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------

/** รัน scheduling scan ทั้ง A + B (เรียกจาก cron) */
export async function runScheduling(
  deps: SchedulingDeps
): Promise<RunSchedulingSummary> {
  const resolved = {
    db: deps.db,
    now: deps.now ? deps.now() : new Date(),
    getActiveVersion: deps.getActiveVersion ?? getActiveVersionByType,
    generateToken: deps.generateToken ?? generateInvitationToken,
  };
  const pageSize =
    deps.pageSize && deps.pageSize > 0 ? deps.pageSize : CUSTOMER_PAGE_SIZE;

  let customers: CustomerRow[];
  try {
    customers = await loadActiveCustomers(resolved.db, pageSize);
  } catch (e) {
    return {
      office: emptySummary(),
      accountant: emptySummary(),
      skippedAll: true,
      reason: e instanceof Error ? e.message : "load_failed",
    };
  }

  // M1 — ครอบ scan แต่ละชนิดด้วย try/catch: error ที่ไม่คาดคิดในชนิดหนึ่ง
  //   ต้องไม่ทำให้อีกชนิด/ทั้งรอบล้ม (คืน summary ว่างของชนิดที่พัง)
  const office = await runScanSafe(() => scanOffice(resolved, customers));
  const accountant = await runScanSafe(() => scanAccountant(resolved, customers));

  return { office, accountant, skippedAll: false };
}

/** เรียก scan แบบกันพัง — คืน emptySummary ถ้า throw (isolation ระดับชนิด — M1) */
async function runScanSafe(
  fn: () => Promise<ScanSummary>
): Promise<ScanSummary> {
  try {
    return await fn();
  } catch {
    return emptySummary();
  }
}
