import type { SupabaseClient } from "@supabase/supabase-js";
import { getLiffId, getOfficeGroupId as getEnvOfficeGroupId, type LineOa } from "@/lib/env";
import { getLineClient, type LineClient } from "@/lib/line/client";
import { oaForSurveyType, channelForSurveyType } from "@/lib/line/routing";
import { buildInvitationFlex, buildLiffSurveyUrl } from "@/lib/line/messages";

/**
 * Notification / Push worker (FR-SC, FR-NT)
 *   ดึง job_queue(notification) → ส่งแบบประเมินทาง LINE ตาม OA + ช่องทาง:
 *     A (สำนักงาน) → OA Care → กลุ่ม LINE (push group id)
 *     B (นักบัญชี)  → OA Care → แชตส่วนตัว (push userId)
 *     C/D (เซล)     → OA Sale → แชตส่วนตัว (push userId)
 *   + log notification_logs + retry/backoff/dead
 *
 *   เตือนอัตโนมัติ 1 ครั้ง/1 วัน (processReminders): ยังไม่ตอบ + ผ่าน 1 วัน +
 *   ยังไม่เคยเตือน → mark reminded (guard reminder_count=0) → enqueue reminder → หยุด
 *
 * inject deps เพื่อ test ได้โดยไม่ต้องมี LINE env/network จริง
 */

const DEFAULT_BATCH = 20;
const BACKOFF_BASE_SEC = 60;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type NotifyDeps = {
  db: SupabaseClient;
  /** คืน client ของ OA (null = ไม่มี credential) — default: getLineClient จาก env */
  getClient?: (oa: LineOa) => LineClient | null;
  /** LIFF id ต่อ OA — default: getLiffId จาก env */
  getLiffId?: (oa: LineOa) => string | undefined;
  /** group id ของกลุ่มสำนักงาน (fallback) — default: env */
  getOfficeGroupId?: () => string | undefined;
  now?: () => Date;
};

export type NotifySummary = {
  processed: number;
  sent: number;
  failed: number; // กลับเข้าคิว (retry)
  dead: number; // ย้าย dead
  deferred: number; // ยังส่งไม่ได้ (ไม่มี credential/ยังไม่ลิงก์) — คง pending
  skipped: boolean;
  reason?: string;
};

type NotifJob = {
  id: string;
  tenant_id: string;
  payload: {
    kind?: string; // survey_invitation | reminder
    invitation_id?: string;
    survey_type?: string;
    oa?: LineOa;
    group_id?: string;
  } | null;
  attempts: number;
  max_attempts: number;
};

type InvitationRow = {
  id: string;
  tenant_id: string;
  survey_type: string;
  status: string;
  line_user_id: string | null;
  token: string;
  first_sent_at: string | null;
  reminder_count: number;
  customer_id: string;
};

// ---------------------------------------------------------------------
// reminder-due logic (pure) — test ได้ทันที
// ---------------------------------------------------------------------
export type ReminderDueInput = {
  status: string;
  reminder_count: number;
  first_sent_at: string | null;
  now?: Date;
  /** ระยะเวลาก่อนเตือน (default 1 วัน) */
  thresholdMs?: number;
};

/**
 * ควรเตือนหรือยัง (จำกัด 1 ครั้ง/1 วัน)
 *   เงื่อนไข: เคยส่งครั้งแรกแล้ว + ยังไม่ตอบ/ไม่หมดอายุ + ยังไม่เคยเตือน + ผ่าน 1 วัน
 */
export function isReminderDue(input: ReminderDueInput): boolean {
  if (!input.first_sent_at) return false; // ยังไม่เคยส่งครั้งแรก
  if (input.status === "responded" || input.status === "expired") return false;
  if (input.reminder_count >= 1) return false; // เตือนไปแล้ว → หยุด

  const now = input.now ?? new Date();
  const threshold = input.thresholdMs ?? ONE_DAY_MS;
  const firstSent = new Date(input.first_sent_at).getTime();
  if (!Number.isFinite(firstSent)) return false;

  return now.getTime() - firstSent >= threshold;
}

// ---------------------------------------------------------------------
// helper: resolve deps ให้มี default อ่านจาก env
// ---------------------------------------------------------------------
function resolveDeps(deps: NotifyDeps) {
  return {
    db: deps.db,
    getClient: deps.getClient ?? getLineClient,
    liffId: deps.getLiffId ?? getLiffId,
    officeGroupId: deps.getOfficeGroupId ?? getEnvOfficeGroupId,
    now: deps.now ? deps.now() : new Date(),
  };
}

async function loadInvitation(
  db: SupabaseClient,
  invitationId: string
): Promise<InvitationRow | null> {
  const { data } = await db
    .from("survey_invitations")
    .select(
      "id, tenant_id, survey_type, status, line_user_id, token, first_sent_at, reminder_count, customer_id"
    )
    .eq("id", invitationId)
    .maybeSingle();
  return (data as InvitationRow | null) ?? null;
}

/** หา LINE userId จริง (U...) + สถานะ block จาก line_users ที่ผูก invitation */
async function loadLineUser(
  db: SupabaseClient,
  lineUserPk: string
): Promise<{ line_user_id: string; is_blocked: boolean } | null> {
  const { data } = await db
    .from("line_users")
    .select("line_user_id, is_blocked")
    .eq("id", lineUserPk)
    .maybeSingle();
  return (data as { line_user_id: string; is_blocked: boolean } | null) ?? null;
}

async function logNotification(
  db: SupabaseClient,
  args: {
    tenantId: string;
    invitationId: string;
    status: "sent" | "failed";
    messageId?: string;
    error?: string;
    now: Date;
  }
): Promise<void> {
  await db.from("notification_logs").insert({
    tenant_id: args.tenantId,
    target: "customer",
    channel: "line",
    ref_type: "invitation",
    ref_id: args.invitationId,
    status: args.status,
    provider_message_id: args.messageId ?? null,
    error: args.error ? args.error.slice(0, 500) : null,
    sent_at: args.status === "sent" ? args.now.toISOString() : null,
  });
}

type ResolvedDeps = ReturnType<typeof resolveDeps>;

/** ประมวลผล 1 job → outcome */
async function processNotifJob(
  rd: ResolvedDeps,
  job: NotifJob
): Promise<"sent" | "retry" | "dead" | "deferred" | "done"> {
  const { db, now } = rd;
  const invitationId = job.payload?.invitation_id;
  const isReminder = job.payload?.kind === "reminder";

  const fail = async (msg: string): Promise<"retry" | "dead"> => {
    const attempts = job.attempts + 1;
    const isDead = attempts >= job.max_attempts;
    await db
      .from("job_queue")
      .update({
        status: isDead ? "dead" : "pending",
        attempts,
        last_error: msg.slice(0, 500),
        locked_at: null,
        run_at: isDead
          ? now.toISOString()
          : new Date(now.getTime() + attempts * BACKOFF_BASE_SEC * 1000).toISOString(),
      })
      .eq("id", job.id);
    return isDead ? "dead" : "retry";
  };

  // คง pending โดยไม่เพิ่ม attempts (degrade — รอ credential/ลิงก์ในรอบหน้า)
  const defer = async (msg: string): Promise<"deferred"> => {
    await db
      .from("job_queue")
      .update({
        status: "pending",
        last_error: msg.slice(0, 500),
        locked_at: null,
        run_at: new Date(now.getTime() + BACKOFF_BASE_SEC * 1000).toISOString(),
      })
      .eq("id", job.id);
    return "deferred";
  };

  const markDone = async (): Promise<"done"> => {
    await db
      .from("job_queue")
      .update({ status: "sent", last_error: null, locked_at: null })
      .eq("id", job.id);
    return "done";
  };

  if (!invitationId) return fail("missing_invitation_id");

  const inv = await loadInvitation(db, invitationId);
  if (!inv) return fail("invitation_not_found");

  // หยุดส่งเมื่อ ตอบแล้ว/หมดอายุ (FR-SC-04) — ถือว่างานจบ ไม่ retry
  if (inv.status === "responded" || inv.status === "expired") {
    return markDone();
  }

  const oa = job.payload?.oa ?? oaForSurveyType(inv.survey_type);
  const channel = channelForSurveyType(inv.survey_type);

  // ต้องมี LIFF id (สร้างลิงก์เปิดแบบประเมิน) — ยังไม่ตั้ง = degrade
  const liffId = rd.liffId(oa);
  if (!liffId) return defer(`liff_unconfigured:${oa}`);

  // ต้องมี client (access token) — ยังไม่ตั้ง = degrade
  const client = rd.getClient(oa);
  if (!client) return defer(`line_client_unconfigured:${oa}`);

  // หา target ปลายทาง
  let to: string;
  if (channel === "group") {
    const groupId = job.payload?.group_id ?? rd.officeGroupId();
    if (!groupId) return defer("office_group_unconfigured");
    to = groupId;
  } else {
    if (!inv.line_user_id) return fail("line_user_not_linked");
    const lineUser = await loadLineUser(db, inv.line_user_id);
    if (!lineUser) return fail("line_user_not_found");
    if (lineUser.is_blocked) {
      // ลูกค้าบล็อก OA → ส่งไม่ได้ หยุด (ไม่ retry)
      return markDone();
    }
    to = lineUser.line_user_id;
  }

  const liffUrl = buildLiffSurveyUrl(liffId, inv.token);
  const flex = buildInvitationFlex({ liffUrl, isReminder });

  const result = await client.push(to, [flex]);

  if (!result.ok) {
    await logNotification(db, {
      tenantId: inv.tenant_id,
      invitationId,
      status: "failed",
      error: result.error,
      now,
    });
    if (result.retryable) return fail(result.error);
    // error ถาวร (4xx) → ไม่ retry เปล่าประโยชน์ → dead ทันที
    await db
      .from("job_queue")
      .update({
        status: "dead",
        attempts: job.attempts + 1,
        last_error: result.error.slice(0, 500),
        locked_at: null,
      })
      .eq("id", job.id);
    return "dead";
  }

  // ส่งสำเร็จ → log + อัปเดต invitation
  await logNotification(db, {
    tenantId: inv.tenant_id,
    invitationId,
    status: "sent",
    messageId: result.messageId,
    now,
  });

  if (isReminder) {
    // reminder_count/last_reminded_at ถูก mark ไปแล้วตอน enqueue (กันเกิน 1)
    // ที่นี่ไม่ต้องแตะ เพื่อคง "1 ครั้ง"
  } else {
    // ส่งครั้งแรก → mark status sent + first_sent_at (ถ้ายังไม่มี)
    const patch: Record<string, unknown> = {};
    if (inv.status === "pending") patch.status = "sent";
    if (!inv.first_sent_at) patch.first_sent_at = now.toISOString();
    if (Object.keys(patch).length > 0) {
      await db.from("survey_invitations").update(patch).eq("id", invitationId);
    }
  }

  await markDone();
  return "sent";
}

/** ดึง+ส่งงาน notification เป็น batch */
export async function processNotificationJobs(
  deps: NotifyDeps,
  opts: { limit?: number } = {}
): Promise<NotifySummary> {
  const rd = resolveDeps(deps);
  const { db, now } = rd;
  const limit = opts.limit ?? DEFAULT_BATCH;

  const summary: NotifySummary = {
    processed: 0,
    sent: 0,
    failed: 0,
    dead: 0,
    deferred: 0,
    skipped: false,
  };

  const { data: jobs, error } = await db
    .from("job_queue")
    .select("id, tenant_id, payload, attempts, max_attempts")
    .eq("queue", "notification")
    .eq("status", "pending")
    .lte("run_at", now.toISOString())
    .order("run_at", { ascending: true })
    .limit(limit);

  if (error) {
    summary.skipped = true;
    summary.reason = `pull_failed: ${error.message ?? "unknown"}`;
    return summary;
  }

  for (const raw of (jobs ?? []) as NotifJob[]) {
    const { data: claimed } = await db
      .from("job_queue")
      .update({ status: "processing", locked_at: now.toISOString() })
      .eq("id", raw.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    summary.processed += 1;
    const outcome = await processNotifJob(rd, raw);
    if (outcome === "sent") summary.sent += 1;
    else if (outcome === "dead") summary.dead += 1;
    else if (outcome === "deferred") summary.deferred += 1;
    else if (outcome === "retry") summary.failed += 1;
    // "done" (หยุดส่งเพราะตอบแล้ว/บล็อก) — ไม่นับเป็น sent/failed
  }

  return summary;
}

// ---------------------------------------------------------------------
// reminder scan: หา invitation ครบกำหนดเตือน → mark (guard) → enqueue reminder
// ---------------------------------------------------------------------
export type ReminderScanSummary = {
  scanned: number;
  enqueued: number;
  skipped: boolean;
  reason?: string;
};

export async function processReminders(
  deps: NotifyDeps,
  opts: { limit?: number } = {}
): Promise<ReminderScanSummary> {
  const now = deps.now ? deps.now() : new Date();
  const db = deps.db;
  const limit = opts.limit ?? 100;

  const summary: ReminderScanSummary = { scanned: 0, enqueued: 0, skipped: false };
  const cutoff = new Date(now.getTime() - ONE_DAY_MS).toISOString();

  // ยังไม่ตอบ (sent/opened) + ยังไม่เคยเตือน + ส่งครั้งแรกเกิน 1 วัน
  const { data: rows, error } = await db
    .from("survey_invitations")
    .select("id, tenant_id, survey_type, status, first_sent_at, reminder_count")
    .in("status", ["sent", "opened"])
    .eq("reminder_count", 0)
    .not("first_sent_at", "is", null)
    .lte("first_sent_at", cutoff)
    .order("first_sent_at", { ascending: true })
    .limit(limit);

  if (error) {
    summary.skipped = true;
    summary.reason = `scan_failed: ${error.message ?? "unknown"}`;
    return summary;
  }

  for (const raw of (rows ?? []) as {
    id: string;
    tenant_id: string;
    survey_type: string;
    status: string;
    first_sent_at: string | null;
    reminder_count: number;
  }[]) {
    summary.scanned += 1;

    // ป้องกันชั้นสอง (pure) — เผื่อ filter DB เพี้ยน
    if (
      !isReminderDue({
        status: raw.status,
        reminder_count: raw.reminder_count,
        first_sent_at: raw.first_sent_at,
        now,
      })
    ) {
      continue;
    }

    // mark reminded แบบ guard (reminder_count=0) — กันเตือนเกิน 1 / กัน cron ซ้อน
    const { data: marked } = await db
      .from("survey_invitations")
      .update({ reminder_count: 1, last_reminded_at: now.toISOString() })
      .eq("id", raw.id)
      .eq("reminder_count", 0)
      .select("id")
      .maybeSingle();
    if (!marked) continue; // มีคนเตือนไปก่อนแล้ว

    // enqueue reminder job (ส่งจริงผ่าน retry path เดียวกัน)
    await db.from("job_queue").insert({
      tenant_id: raw.tenant_id,
      queue: "notification",
      payload: {
        kind: "reminder",
        invitation_id: raw.id,
        survey_type: raw.survey_type,
        oa: oaForSurveyType(raw.survey_type),
      },
    });
    summary.enqueued += 1;
  }

  return summary;
}
