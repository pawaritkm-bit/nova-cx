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

/** จำกัดจำนวนลูกค้าต่อรอบ scan (กัน timeout; รอบถัดไปเก็บตกได้เพราะ idempotent) */
const CUSTOMER_BATCH = 500;

export type SchedulingDeps = {
  db: DB;
  now?: () => Date;
  /** ดึง template+version ที่ active ตามชนิด — default: survey/service */
  getActiveVersion?: typeof getActiveVersionByType;
  /** สร้าง token — default: survey/token */
  generateToken?: () => string;
};

export type ScanSummary = {
  scanned: number; // ลูกค้าที่พิจารณา
  created: number; // invitation สร้างใหม่ + enqueue
  existed: number; // มีอยู่แล้ว (idempotent skip)
  skipped: number; // ไม่เข้าเงื่อนไข/หยุด (ไม่ถึงรอบ, ยกเลิก, บล็อก ฯลฯ)
  noTemplate: number; // ยังไม่ตั้ง template ชนิดนั้น
};

export type RunSchedulingSummary = {
  office: ScanSummary;
  accountant: ScanSummary;
  skippedAll: boolean;
  reason?: string;
};

function emptySummary(): ScanSummary {
  return { scanned: 0, created: 0, existed: 0, skipped: 0, noTemplate: 0 };
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

/** ลูกค้าที่ active + ไม่ถูกลบ (candidate สำหรับ A/B) */
async function loadActiveCustomers(db: DB): Promise<CustomerRow[]> {
  const { data, error } = await db
    .from("customers")
    .select("id, tenant_id, service_start_date, status, deleted_at")
    .eq("status", "active")
    .is("deleted_at", null)
    .limit(CUSTOMER_BATCH);
  if (error) throw new Error(error.message ?? "load_customers_failed");
  return (data ?? []) as CustomerRow[];
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

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: string }).code === "23505"
  );
}

/**
 * insert invitation + enqueue notification job
 * คืน "created" | "existed" (แข่ง unique constraint แล้วมีคนสร้างก่อน = existed)
 */
async function createInvitationAndEnqueue(
  args: CreateArgs
): Promise<"created" | "existed"> {
  const { db, surveyType, now } = args;

  const { data, error } = await db
    .from("survey_invitations")
    .insert({
      tenant_id: args.tenantId,
      customer_id: args.customerId,
      line_user_id: args.lineUserId,
      survey_type: surveyType,
      survey_version_id: args.versionId,
      cycle_period: args.cyclePeriod,
      assignee_snapshot: args.assigneeSnapshot,
      token: args.token,
      token_expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
      status: "pending",
      idempotency_key: args.idempotencyKey,
    })
    .select("id")
    .single();

  if (error) {
    // race: unique(customer_id,survey_type,cycle_period) หรือ (tenant,idempotency_key) ชน
    if (isUniqueViolation(error)) return "existed";
    throw new Error(error.message ?? "insert_invitation_failed");
  }

  const invitationId = (data as { id: string }).id;

  await db.from("job_queue").insert({
    tenant_id: args.tenantId,
    queue: "notification",
    payload: {
      kind: "survey_invitation",
      invitation_id: invitationId,
      survey_type: surveyType,
      oa: oaForSurveyType(surveyType),
    },
  });

  return "created";
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

    // A ส่งเข้ากลุ่ม (group) — block รายบุคคลไม่ตัดสิทธิ์ แต่ผูก owner ไว้ถ้ามี
    const lineUsers = await loadLineUsers(db, c.tenant_id, c.id);
    const lineUserId = pickReachableLineUserId(lineUsers);

    const outcome = await createInvitationAndEnqueue({
      db,
      tenantId: c.tenant_id,
      customerId: c.id,
      surveyType: "A",
      cyclePeriod: cycle.cyclePeriod,
      versionId: found.version.id,
      lineUserId,
      assigneeSnapshot: [], // A = ประเมินภาพรวมสำนักงาน (ไม่ผูกรายบุคคล)
      idempotencyKey,
      token: generateToken(),
      now,
    });
    if (outcome === "created") summary.created += 1;
    else summary.existed += 1;
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

  let customers: CustomerRow[];
  try {
    customers = await loadActiveCustomers(resolved.db);
  } catch (e) {
    return {
      office: emptySummary(),
      accountant: emptySummary(),
      skippedAll: true,
      reason: e instanceof Error ? e.message : "load_failed",
    };
  }

  const office = await scanOffice(resolved, customers);
  const accountant = await scanAccountant(resolved, customers);

  return { office, accountant, skippedAll: false };
}
