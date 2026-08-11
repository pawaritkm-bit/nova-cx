import { describe, it, expect, beforeEach } from "vitest";
import { makeInMemoryDb, type Tables } from "../helpers/fake-payroll-db";
import {
  calcPitDeadline,
  calcSsoDeadline,
  isReminderDue,
  generateDueReminders,
  listActiveFilingReminders,
  countPendingFilingUnits,
} from "@/lib/accounting/payroll-filing-reminders";

/**
 * เทสต์ lib/accounting/payroll-filing-reminders.ts (เฟส 9b กลุ่ม BG, T168-T174, docs/06 หมวด 0.6)
 *   ★ pure: calcPitDeadline/calcSsoDeadline/isReminderDue
 *   ★ orchestrator: generateDueReminders (dedup ด้วย unique index จำลอง), listActiveFilingReminders (banner UI)
 */

describe("calcPitDeadline/calcSsoDeadline — วันที่ 15 ของเดือนถัดไป (periodYear เป็น พ.ศ.)", () => {
  it("เดือนปกติ (ไม่ข้ามปี) → เดือนถัดไปปีเดียวกัน (ค.ศ.)", () => {
    expect(calcPitDeadline(2569, 7)).toBe("2026-08-15");
    expect(calcSsoDeadline(2569, 7)).toBe("2026-08-15");
  });

  it("★★★ ข้ามปี — เดือน 12 → deadline เดือน 1 ปีถัดไป (ค.ศ.)", () => {
    expect(calcPitDeadline(2569, 12)).toBe("2027-01-15");
    expect(calcSsoDeadline(2569, 12)).toBe("2027-01-15");
  });

  it("ปีอธิกสุรทินไม่กระทบ — deadline เป็นวันที่ 15 คงที่ไม่ว่าเดือนถัดไปมีกี่วัน", () => {
    // periodMonth=1 (ม.ค. 2569=ค.ศ.2026) → deadline ก.พ. 2026 (28 วัน ไม่อธิกสุรทิน) ยังได้วันที่ 15 เป๊ะ
    expect(calcPitDeadline(2569, 1)).toBe("2026-02-15");
    // periodMonth=1 ของปี พ.ศ.2571 (ค.ศ.2028 อธิกสุรทิน) → deadline ก.พ. 2028 (29 วัน) ยังได้วันที่ 15 เป๊ะ
    expect(calcPitDeadline(2571, 1)).toBe("2028-02-15");
  });
});

describe("isReminderDue — stage ตามระยะเทียบวันครบกำหนด", () => {
  const deadline = "2026-08-15";

  it("เกิน 3 วันก่อนกำหนด → null (ยังไม่ถึงช่วงแจ้งเตือน)", () => {
    expect(isReminderDue(deadline, "2026-08-10")).toBeNull();
    expect(isReminderDue(deadline, "2026-08-01")).toBeNull();
  });

  it("พอดี 3 วันก่อนกำหนด → due_soon", () => {
    expect(isReminderDue(deadline, "2026-08-12")).toBe("due_soon");
  });

  it("1-2 วันก่อนกำหนด (นอกช่วง buffer ที่กำหนด) → null", () => {
    expect(isReminderDue(deadline, "2026-08-13")).toBeNull();
    expect(isReminderDue(deadline, "2026-08-14")).toBeNull();
  });

  it("วันนี้ตรงกับวันครบกำหนดเป๊ะ → due_today", () => {
    expect(isReminderDue(deadline, "2026-08-15")).toBe("due_today");
  });

  it("เกินกำหนดแล้ว (ทุกวันหลังจากนั้น) → overdue เสมอ", () => {
    expect(isReminderDue(deadline, "2026-08-16")).toBe("overdue");
    expect(isReminderDue(deadline, "2026-09-30")).toBe("overdue");
  });
});

function baseTables(): Tables {
  return {
    payroll_monthly_filings: [],
    payroll_filing_reminders: [],
  };
}

const UNIQUE_INDEXES = [
  {
    table: "payroll_filing_reminders",
    columns: ["filing_period_id", "kind", "reminder_stage"] as string[],
    where: (_r: unknown) => true,
  },
];

describe("generateDueReminders (T170)", () => {
  let tables: Tables;
  beforeEach(() => {
    tables = baseTables();
  });

  it("filing period ที่ยื่นแล้วครบทั้ง pit/sso ('filed') → ไม่ generate reminder เลย", async () => {
    tables.payroll_monthly_filings.push({
      id: "fp-1",
      tenant_id: "t1",
      customer_id: "c1",
      period_year: 2569,
      period_month: 7, // deadline = 2026-08-15
      pit_filing_status: "filed",
      sso_filing_status: "filed",
    });
    const { db } = makeInMemoryDb(tables, { uniqueIndexes: UNIQUE_INDEXES });
    const result = await generateDueReminders(db, "2026-08-15");
    expect(result.scannedPeriods).toBe(0);
    expect(result.generated).toBe(0);
    expect(tables.payroll_filing_reminders).toHaveLength(0);
  });

  it("★★★ ยังไม่ยื่น + วันนี้ตรง due_today → generate 1 แถว", async () => {
    tables.payroll_monthly_filings.push({
      id: "fp-1",
      tenant_id: "t1",
      customer_id: "c1",
      period_year: 2569,
      period_month: 7, // deadline = 2026-08-15
      pit_filing_status: "not_filed",
      sso_filing_status: "filed",
    });
    const { db } = makeInMemoryDb(tables, { uniqueIndexes: UNIQUE_INDEXES });
    const result = await generateDueReminders(db, "2026-08-15");
    expect(result.scannedPeriods).toBe(1);
    expect(result.generated).toBe(1);
    expect(tables.payroll_filing_reminders).toHaveLength(1);
    const row = tables.payroll_filing_reminders[0];
    expect(row.kind).toBe("pit");
    expect(row.reminder_stage).toBe("due_today");
    // sso ยื่นแล้ว ไม่ต้องแจ้ง
    expect(tables.payroll_filing_reminders.some((r) => r.kind === "sso")).toBe(false);
  });

  it("★★★ เรียกซ้ำวันเดียวกัน 2 ครั้ง → ไม่สร้างแถวซ้ำ (unique constraint กัน dedup)", async () => {
    tables.payroll_monthly_filings.push({
      id: "fp-1",
      tenant_id: "t1",
      customer_id: "c1",
      period_year: 2569,
      period_month: 7,
      pit_filing_status: "not_filed",
      sso_filing_status: "not_filed",
    });
    const { db } = makeInMemoryDb(tables, { uniqueIndexes: UNIQUE_INDEXES });
    const r1 = await generateDueReminders(db, "2026-08-15");
    const r2 = await generateDueReminders(db, "2026-08-15");
    expect(r1.generated).toBe(2); // pit + sso ทั้งคู่ due_today
    expect(r2.generated).toBe(0);
    expect(r2.skipped).toBe(2); // ชน unique — ถือว่า skip ไม่ใช่ error
    expect(tables.payroll_filing_reminders).toHaveLength(2);
  });

  it("★★★ เรียกวันถัดมาที่ stage เปลี่ยน (due_soon → due_today) → สร้างแถวใหม่ได้ (stage ต่างกัน ไม่ชน unique เดิม)", async () => {
    tables.payroll_monthly_filings.push({
      id: "fp-1",
      tenant_id: "t1",
      customer_id: "c1",
      period_year: 2569,
      period_month: 7, // deadline = 2026-08-15
      pit_filing_status: "not_filed",
      sso_filing_status: "filed",
    });
    const { db } = makeInMemoryDb(tables, { uniqueIndexes: UNIQUE_INDEXES });
    const dueSoon = await generateDueReminders(db, "2026-08-12"); // deadline-3 → due_soon
    expect(dueSoon.generated).toBe(1);
    const dueToday = await generateDueReminders(db, "2026-08-15"); // due_today (stage ต่างจากครั้งก่อน)
    expect(dueToday.generated).toBe(1);
    expect(tables.payroll_filing_reminders).toHaveLength(2);
    const stages = tables.payroll_filing_reminders.map((r) => r.reminder_stage).sort();
    expect(stages).toEqual(["due_soon", "due_today"]);
  });

  it("ทุก tenant ถูก scan (service-role ไม่ผูก tenant เดียว)", async () => {
    tables.payroll_monthly_filings.push(
      { id: "fp-1", tenant_id: "t1", customer_id: "c1", period_year: 2569, period_month: 7, pit_filing_status: "not_filed", sso_filing_status: "filed" },
      { id: "fp-2", tenant_id: "t2", customer_id: "c2", period_year: 2569, period_month: 7, pit_filing_status: "not_filed", sso_filing_status: "filed" }
    );
    const { db } = makeInMemoryDb(tables, { uniqueIndexes: UNIQUE_INDEXES });
    const result = await generateDueReminders(db, "2026-08-15");
    expect(result.tenants).toBe(2);
    expect(result.generated).toBe(2);
  });
});

describe("listActiveFilingReminders / countPendingFilingUnits (T173, banner UI)", () => {
  let tables: Tables;
  beforeEach(() => {
    tables = baseTables();
  });

  it("ไม่มี filing period ที่ pending เลย → คืน [] (ไม่มี banner)", async () => {
    tables.payroll_monthly_filings.push({
      id: "fp-1",
      tenant_id: "t1",
      customer_id: "c1",
      period_year: 2569,
      period_month: 7,
      pit_filing_status: "filed",
      sso_filing_status: "filed",
    });
    const { db } = makeInMemoryDb(tables);
    const items = await listActiveFilingReminders(db, "t1", "c1");
    expect(items).toEqual([]);
    expect(countPendingFilingUnits(items)).toBe(0);
  });

  it("มี filing period pending แต่ยังไม่เคยมี reminder log เลย → ไม่แสดง (ต้องรอ cron generate ก่อน)", async () => {
    tables.payroll_monthly_filings.push({
      id: "fp-1",
      tenant_id: "t1",
      customer_id: "c1",
      period_year: 2569,
      period_month: 7,
      pit_filing_status: "not_filed",
      sso_filing_status: "not_filed",
    });
    const { db } = makeInMemoryDb(tables);
    const items = await listActiveFilingReminders(db, "t1", "c1");
    expect(items).toEqual([]);
  });

  it("★★★ มี reminder log ค้างอยู่ + สถานะยื่นยังไม่ครบ → แสดง banner ถูกต้อง", async () => {
    tables.payroll_monthly_filings.push({
      id: "fp-1",
      tenant_id: "t1",
      customer_id: "c1",
      period_year: 2569,
      period_month: 7,
      pit_filing_status: "not_filed",
      sso_filing_status: "filed",
    });
    tables.payroll_filing_reminders.push({
      id: "r1",
      tenant_id: "t1",
      filing_period_id: "fp-1",
      kind: "pit",
      reminder_stage: "overdue",
      deadline: "2026-08-15",
      created_at: "2026-08-16T00:00:00.000Z",
    });
    const { db } = makeInMemoryDb(tables);
    const items = await listActiveFilingReminders(db, "t1", "c1");
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("pit");
    expect(items[0].stage).toBe("overdue");
    expect(countPendingFilingUnits(items)).toBe(1);
  });

  it("★★★ ยื่นไปแล้วหลังจากที่เคยมี reminder ค้างอยู่ → banner ต้องหายไปทันที (ใช้สถานะยื่นปัจจุบันจริงชี้ขาด)", async () => {
    tables.payroll_monthly_filings.push({
      id: "fp-1",
      tenant_id: "t1",
      customer_id: "c1",
      period_year: 2569,
      period_month: 7,
      pit_filing_status: "filed", // ยื่นไปแล้ว
      sso_filing_status: "filed",
    });
    tables.payroll_filing_reminders.push({
      id: "r1",
      tenant_id: "t1",
      filing_period_id: "fp-1",
      kind: "pit",
      reminder_stage: "overdue",
      deadline: "2026-08-15",
      created_at: "2026-08-16T00:00:00.000Z",
    });
    const { db } = makeInMemoryDb(tables);
    const items = await listActiveFilingReminders(db, "t1", "c1");
    expect(items).toEqual([]);
  });

  it("IDOR-safe — ลูกค้า/tenant อื่นไม่ติดมาด้วย", async () => {
    tables.payroll_monthly_filings.push(
      { id: "fp-1", tenant_id: "t1", customer_id: "c1", period_year: 2569, period_month: 7, pit_filing_status: "not_filed", sso_filing_status: "filed" },
      { id: "fp-2", tenant_id: "t1", customer_id: "c-other", period_year: 2569, period_month: 7, pit_filing_status: "not_filed", sso_filing_status: "filed" },
      { id: "fp-3", tenant_id: "t-other", customer_id: "c1", period_year: 2569, period_month: 7, pit_filing_status: "not_filed", sso_filing_status: "filed" }
    );
    tables.payroll_filing_reminders.push(
      { id: "r1", tenant_id: "t1", filing_period_id: "fp-1", kind: "pit", reminder_stage: "overdue", deadline: "2026-08-15", created_at: "2026-08-16T00:00:00.000Z" },
      { id: "r2", tenant_id: "t1", filing_period_id: "fp-2", kind: "pit", reminder_stage: "overdue", deadline: "2026-08-15", created_at: "2026-08-16T00:00:00.000Z" },
      { id: "r3", tenant_id: "t-other", filing_period_id: "fp-3", kind: "pit", reminder_stage: "overdue", deadline: "2026-08-15", created_at: "2026-08-16T00:00:00.000Z" }
    );
    const { db } = makeInMemoryDb(tables);
    const items = await listActiveFilingReminders(db, "t1", "c1");
    expect(items).toHaveLength(1);
    expect(items[0].filingPeriodId).toBe("fp-1");
  });

  it("★ latest reminder ต่อ (period, kind) เท่านั้น — stage เก่าที่ถูกแทนที่แล้วไม่แสดงซ้ำ", async () => {
    tables.payroll_monthly_filings.push({
      id: "fp-1",
      tenant_id: "t1",
      customer_id: "c1",
      period_year: 2569,
      period_month: 7,
      pit_filing_status: "not_filed",
      sso_filing_status: "filed",
    });
    tables.payroll_filing_reminders.push(
      { id: "r1", tenant_id: "t1", filing_period_id: "fp-1", kind: "pit", reminder_stage: "due_soon", deadline: "2026-08-15", created_at: "2026-08-12T00:00:00.000Z" },
      { id: "r2", tenant_id: "t1", filing_period_id: "fp-1", kind: "pit", reminder_stage: "overdue", deadline: "2026-08-15", created_at: "2026-08-20T00:00:00.000Z" }
    );
    const { db } = makeInMemoryDb(tables);
    const items = await listActiveFilingReminders(db, "t1", "c1");
    expect(items).toHaveLength(1);
    expect(items[0].stage).toBe("overdue"); // ล่าสุด ไม่ใช่ due_soon เก่า
  });
});
