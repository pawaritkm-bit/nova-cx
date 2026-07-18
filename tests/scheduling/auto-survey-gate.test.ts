import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runScheduling } from "@/lib/scheduling/engine";

/**
 * Gate สวิตช์ต่อลูกค้า (0029): รอบอัตโนมัติ (A/B) ต้องเลือกเฉพาะลูกค้าที่
 *   auto_survey_enabled = true — ลูกค้าที่ปิดสวิตช์ต้อง "ไม่ถูกดึงมาสแกน"
 *   ทดสอบโดยจับ eq() filter ที่ engine ใส่บน query ตาราง customers
 */

type EqCall = [string, unknown];

/** mock ที่บันทึก eq() ของ query customers + จำลองว่า DB กรองตาม auto_survey_enabled จริง */
function makeDb(rows: Record<string, unknown>[], captured: EqCall[]): SupabaseClient {
  class QB {
    private eqs: EqCall[] = [];
    private isCustomers: boolean;
    constructor(private table: string) {
      this.isCustomers = table === "customers";
    }
    select() {
      return this;
    }
    eq(col: string, val: unknown) {
      this.eqs.push([col, val]);
      if (this.isCustomers) captured.push([col, val]);
      return this;
    }
    is() {
      return this;
    }
    in() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    not() {
      return this;
    }
    maybeSingle() {
      return Promise.resolve({ data: null, error: null });
    }
    range() {
      // จำลอง DB กรอง: คืนเฉพาะแถวที่ผ่าน eq ทุกตัว (customers เท่านั้น)
      if (this.isCustomers) {
        const filtered = rows.filter((r) =>
          this.eqs.every(([c, v]) => (r as Record<string, unknown>)[c] === v)
        );
        return Promise.resolve({ data: filtered, error: null });
      }
      return Promise.resolve({ data: [], error: null });
    }
  }
  return {
    from(table: string) {
      return new QB(table);
    },
    rpc() {
      return Promise.resolve({ data: { created: true }, error: null });
    },
  } as unknown as SupabaseClient;
}

describe("gate auto_survey_enabled (0029) — รอบอัตโนมัติเลือกเฉพาะลูกค้าที่เปิดสวิตช์", () => {
  it("query customers ใส่เงื่อนไข auto_survey_enabled = true", async () => {
    const captured: EqCall[] = [];
    const db = makeDb([], captured);
    await runScheduling({
      db,
      now: () => new Date("2026-07-15T00:00:00Z"),
      getActiveVersion: async () => null,
      generateToken: () => "tok",
    } as never);

    expect(captured).toContainEqual(["auto_survey_enabled", true]);
    expect(captured).toContainEqual(["status", "active"]);
  });

  it("ลูกค้าปิดสวิตช์ (false) ไม่ถูกดึงมาสแกน (scanned=0)", async () => {
    const captured: EqCall[] = [];
    const db = makeDb(
      [
        {
          id: "c-off",
          tenant_id: "t1",
          service_start_date: "2026-01-15",
          status: "active",
          deleted_at: null,
          auto_survey_enabled: false, // ปิด → ต้องถูกกรองทิ้ง
        },
      ],
      captured
    );

    const r = await runScheduling({
      db,
      now: () => new Date("2026-07-15T00:00:00Z"),
      getActiveVersion: async () => null,
      generateToken: () => "tok",
    } as never);

    expect(r.office.scanned).toBe(0);
    expect(r.accountant.scanned).toBe(0);
  });

  it("ลูกค้าเปิดสวิตช์ (true) ถูกดึงมาสแกน (scanned=1)", async () => {
    const captured: EqCall[] = [];
    const db = makeDb(
      [
        {
          id: "c-on",
          tenant_id: "t1",
          service_start_date: "2026-01-15",
          status: "active",
          deleted_at: null,
          auto_survey_enabled: true,
        },
      ],
      captured
    );

    const r = await runScheduling({
      db,
      now: () => new Date("2026-07-15T00:00:00Z"),
      getActiveVersion: async () => null,
      generateToken: () => "tok",
    } as never);

    expect(r.office.scanned).toBe(1);
    expect(r.accountant.scanned).toBe(1);
  });
});
