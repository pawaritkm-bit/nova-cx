import { describe, it, expect } from "vitest";
import { buildHealthPayload, healthPayloadSchema } from "@/lib/health";

describe("lib/health — buildHealthPayload (+ zod schema)", () => {
  it("ไม่มี env → degraded + database skipped + มีข้อความ", () => {
    const p = buildHealthPayload({ timestamp: "2026-01-01T00:00:00Z", hasEnv: false });
    expect(p.status).toBe("degraded");
    expect(p.checks.env).toBe(false);
    expect(p.checks.database).toBe("skipped");
    expect(p.message).toBeTypeOf("string");
    expect(() => healthPayloadSchema.parse(p)).not.toThrow();
  });

  it("มี env + DB ต่อได้ → ok + connected", () => {
    const p = buildHealthPayload({
      timestamp: "2026-01-01T00:00:00Z",
      hasEnv: true,
      dbOk: true,
    });
    expect(p.status).toBe("ok");
    expect(p.checks.env).toBe(true);
    expect(p.checks.database).toBe("connected");
    expect(p.checks.databaseError).toBeUndefined();
  });

  it("มี env แต่ DB error → degraded + unreachable + แนบ error", () => {
    const p = buildHealthPayload({
      timestamp: "2026-01-01T00:00:00Z",
      hasEnv: true,
      dbOk: false,
      dbError: 'relation "cron_health" does not exist',
    });
    expect(p.status).toBe("degraded");
    expect(p.checks.database).toBe("unreachable");
    expect(p.checks.databaseError).toContain("cron_health");
  });

  it("payload ทุกกรณีผ่าน zod schema", () => {
    const cases = [
      buildHealthPayload({ timestamp: "t", hasEnv: false }),
      buildHealthPayload({ timestamp: "t", hasEnv: true, dbOk: true }),
      buildHealthPayload({ timestamp: "t", hasEnv: true, dbOk: false, dbError: "x" }),
    ];
    for (const c of cases) {
      expect(() => healthPayloadSchema.parse(c)).not.toThrow();
    }
  });
});
