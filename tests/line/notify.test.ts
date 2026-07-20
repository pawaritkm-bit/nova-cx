import { describe, it, expect } from "vitest";
import type { LineOa } from "@/lib/env";
import type { LineClient, LineSendResult } from "@/lib/line/client";
import {
  isReminderDue,
  processNotificationJobs,
  processReminders,
} from "@/lib/line/notify";
import { makeDb, makeStore, type Store } from "./fake-db";

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// fake LINE client (บันทึก push)
// ---------------------------------------------------------------------
type PushRec = { oa: LineOa; to: string; messages: unknown[] };

function makeClients(result: LineSendResult = { ok: true, messageId: "mid-1" }) {
  const pushes: PushRec[] = [];
  const build = (oa: LineOa): LineClient => ({
    oa,
    async push(to, messages) {
      pushes.push({ oa, to, messages });
      return result;
    },
    async reply() {
      return { ok: true };
    },
    async getProfile() {
      return null;
    },
    async getGroupMemberProfile() {
      return null;
    },
    async getGroupSummary() {
      return null;
    },
  });
  const getClient = (oa: LineOa) => build(oa);
  return { pushes, getClient };
}

const liffAll = (oa: LineOa) => (oa === "sale" ? "liff-sale" : "liff-care");

function invitationJobStore(inv: Record<string, unknown>, kind = "survey_invitation"): Store {
  return makeStore({
    job_queue: [
      {
        id: "job-1",
        tenant_id: "t-1",
        payload: { kind, invitation_id: "inv-1" },
        attempts: 0,
        max_attempts: 5,
      },
    ],
    survey_invitations: {
      id: "inv-1",
      tenant_id: "t-1",
      status: "pending",
      token: "tok-abc",
      first_sent_at: null,
      reminder_count: 0,
      customer_id: "c-1",
      line_user_id: "lu-1",
      ...inv,
    },
    line_users: { line_user_id: "Uabc123", is_blocked: false },
  });
}

// ---------------------------------------------------------------------
describe("isReminderDue — เตือน 1 ครั้ง/1 วัน", () => {
  const base = { status: "sent", reminder_count: 0, first_sent_at: null as string | null };

  it("ยังไม่เคยส่งครั้งแรก (first_sent_at null) → false", () => {
    expect(isReminderDue({ ...base })).toBe(false);
  });

  it("ส่งครบ 1 วัน + ยังไม่ตอบ + ยังไม่เตือน → true", () => {
    const now = new Date("2026-07-15T10:00:00Z");
    const firstSent = new Date(now.getTime() - DAY - 1000).toISOString();
    expect(isReminderDue({ status: "sent", reminder_count: 0, first_sent_at: firstSent, now })).toBe(true);
  });

  it("ยังไม่ถึง 1 วัน → false", () => {
    const now = new Date("2026-07-15T10:00:00Z");
    const firstSent = new Date(now.getTime() - DAY / 2).toISOString();
    expect(isReminderDue({ status: "sent", reminder_count: 0, first_sent_at: firstSent, now })).toBe(false);
  });

  it("เคยเตือนแล้ว (reminder_count=1) → false (จำกัด 1 ครั้ง)", () => {
    const now = new Date("2026-07-15T10:00:00Z");
    const firstSent = new Date(now.getTime() - 3 * DAY).toISOString();
    expect(isReminderDue({ status: "sent", reminder_count: 1, first_sent_at: firstSent, now })).toBe(false);
  });

  it("ตอบแล้ว/หมดอายุ → false", () => {
    const now = new Date("2026-07-15T10:00:00Z");
    const firstSent = new Date(now.getTime() - 3 * DAY).toISOString();
    expect(isReminderDue({ status: "responded", reminder_count: 0, first_sent_at: firstSent, now })).toBe(false);
    expect(isReminderDue({ status: "expired", reminder_count: 0, first_sent_at: firstSent, now })).toBe(false);
  });
});

// ---------------------------------------------------------------------
describe("processNotificationJobs — OA routing + ช่องทาง", () => {
  it("ชนิด B (นักบัญชี) → OA Care + push แชตส่วนตัว (userId จริง)", async () => {
    const store = invitationJobStore({ survey_type: "B" });
    const { pushes, getClient } = makeClients();
    const summary = await processNotificationJobs({
      db: makeDb(store),
      getClient,
      getLiffId: liffAll,
      getOfficeGroupId: () => undefined,
      now: () => new Date("2026-07-15T10:00:00Z"),
    });

    expect(summary.sent).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].oa).toBe("care");
    expect(pushes[0].to).toBe("Uabc123"); // แชตส่วนตัว

    // invitation → status sent + first_sent_at
    const inv = store.updates.find((u) => u.table === "survey_invitations");
    expect(inv?.payload.status).toBe("sent");
    expect(inv?.payload.first_sent_at).toBe("2026-07-15T10:00:00.000Z");

    // log สำเร็จ
    const log = store.inserts.find((i) => i.table === "notification_logs");
    expect(log?.rows[0].status).toBe("sent");
    expect(log?.rows[0].channel).toBe("line");
  });

  it("ชนิด A (สำนักงาน) → OA Care + push เข้ากลุ่ม (group id)", async () => {
    const store = invitationJobStore({ survey_type: "A", line_user_id: null });
    const { pushes, getClient } = makeClients();
    const summary = await processNotificationJobs({
      db: makeDb(store),
      getClient,
      getLiffId: liffAll,
      getOfficeGroupId: () => "Group-999",
      now: () => new Date("2026-07-15T10:00:00Z"),
    });

    expect(summary.sent).toBe(1);
    expect(pushes[0].oa).toBe("care");
    expect(pushes[0].to).toBe("Group-999"); // กลุ่ม LINE
  });

  it("ชนิด C (เซล) → OA Sale + push ส่วนตัว", async () => {
    const store = invitationJobStore({ survey_type: "C" });
    const { pushes, getClient } = makeClients();
    await processNotificationJobs({
      db: makeDb(store),
      getClient,
      getLiffId: liffAll,
      getOfficeGroupId: () => undefined,
      now: () => new Date("2026-07-15T10:00:00Z"),
    });
    expect(pushes[0].oa).toBe("sale");
    expect(pushes[0].to).toBe("Uabc123");
  });

  it("ลูกค้าบล็อก OA → ไม่ push + ปิดงาน (done)", async () => {
    const store = invitationJobStore({ survey_type: "B" });
    store.data.line_users = { line_user_id: "Uabc123", is_blocked: true };
    const { pushes, getClient } = makeClients();
    const summary = await processNotificationJobs({
      db: makeDb(store),
      getClient,
      getLiffId: liffAll,
    });
    expect(pushes).toHaveLength(0);
    expect(summary.sent).toBe(0);
    // job ถูก mark sent (done) เพื่อหยุด
    const jobDone = store.updates.find(
      (u) => u.table === "job_queue" && u.payload.status === "sent"
    );
    expect(jobDone).toBeTruthy();
  });

  it("ตอบแล้ว (responded) → หยุดส่ง (done, ไม่ push)", async () => {
    const store = invitationJobStore({ survey_type: "B", status: "responded" });
    const { pushes, getClient } = makeClients();
    const summary = await processNotificationJobs({
      db: makeDb(store),
      getClient,
      getLiffId: liffAll,
    });
    expect(pushes).toHaveLength(0);
    expect(summary.sent).toBe(0);
  });

  it("ไม่มี client (ยังไม่ตั้ง LINE env) → deferred (คง pending ไม่ crash)", async () => {
    const store = invitationJobStore({ survey_type: "B" });
    const summary = await processNotificationJobs({
      db: makeDb(store),
      getClient: () => null,
      getLiffId: liffAll,
    });
    expect(summary.deferred).toBe(1);
    expect(summary.sent).toBe(0);
    const back = store.updates.find(
      (u) => u.table === "job_queue" && u.payload.status === "pending"
    );
    expect(back).toBeTruthy();
    // ไม่เพิ่ม attempts (degrade ไม่ใช่ fail)
    expect(back?.payload.attempts).toBeUndefined();
  });

  it("push ล้มแบบ retryable → กลับเข้าคิว (failed) + log failed", async () => {
    const store = invitationJobStore({ survey_type: "B" });
    const { getClient } = makeClients({ ok: false, status: 500, error: "line_api_500", retryable: true });
    const summary = await processNotificationJobs({
      db: makeDb(store),
      getClient,
      getLiffId: liffAll,
    });
    expect(summary.failed).toBe(1);
    const log = store.inserts.find((i) => i.table === "notification_logs");
    expect(log?.rows[0].status).toBe("failed");
  });

  it("push ล้มแบบถาวร (4xx) → dead ทันที", async () => {
    const store = invitationJobStore({ survey_type: "B" });
    const { getClient } = makeClients({ ok: false, status: 400, error: "line_api_400", retryable: false });
    const summary = await processNotificationJobs({
      db: makeDb(store),
      getClient,
      getLiffId: liffAll,
    });
    expect(summary.dead).toBe(1);
    const dead = store.updates.find(
      (u) => u.table === "job_queue" && u.payload.status === "dead"
    );
    expect(dead).toBeTruthy();
  });
});

// ---------------------------------------------------------------------
describe("processReminders — เตือนอัตโนมัติ 1 ครั้ง", () => {
  it("ครบกำหนด → mark reminder_count=1 + enqueue reminder job", async () => {
    const now = new Date("2026-07-15T10:00:00Z");
    const store = makeStore({
      survey_invitations: [
        {
          id: "inv-1",
          tenant_id: "t-1",
          survey_type: "B",
          status: "sent",
          reminder_count: 0,
          first_sent_at: new Date(now.getTime() - 2 * DAY).toISOString(),
        },
      ],
    });
    const summary = await processReminders({ db: makeDb(store), now: () => now });

    expect(summary.scanned).toBe(1);
    expect(summary.enqueued).toBe(1);

    // mark guarded
    const mark = store.updates.find((u) => u.table === "survey_invitations");
    expect(mark?.payload.reminder_count).toBe(1);
    expect(mark?.payload.last_reminded_at).toBe(now.toISOString());
    expect(mark?.filters.reminder_count).toBe(0); // guard กันเกิน 1

    // enqueue reminder job
    const job = store.inserts.find((i) => i.table === "job_queue");
    expect(job?.rows[0].queue).toBe("notification");
    expect((job?.rows[0].payload as Record<string, unknown>).kind).toBe("reminder");
    expect((job?.rows[0].payload as Record<string, unknown>).oa).toBe("care");
  });

  it("guarded update คืน null (cron ซ้อน) → ไม่ enqueue", async () => {
    const now = new Date("2026-07-15T10:00:00Z");
    const store = makeStore({
      survey_invitations: [
        {
          id: "inv-1",
          tenant_id: "t-1",
          survey_type: "B",
          status: "sent",
          reminder_count: 0,
          first_sent_at: new Date(now.getTime() - 2 * DAY).toISOString(),
        },
      ],
    });
    store.guardedUpdateReturnsNull = true;
    const summary = await processReminders({ db: makeDb(store), now: () => now });
    expect(summary.scanned).toBe(1);
    expect(summary.enqueued).toBe(0);
    expect(store.inserts.find((i) => i.table === "job_queue")).toBeUndefined();
  });
});
