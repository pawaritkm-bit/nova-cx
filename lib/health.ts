import { z } from "zod";

/**
 * schema ผลลัพธ์ health (ใช้ zod validate ก่อนส่งออก — กัน payload ผิดรูป)
 */
export const healthPayloadSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  timestamp: z.string(),
  checks: z.object({
    env: z.boolean(),
    database: z.enum(["skipped", "connected", "unreachable"]),
    databaseError: z.string().optional(),
  }),
  message: z.string().optional(),
});

export type HealthPayload = z.infer<typeof healthPayloadSchema>;

type BuildArgs = {
  timestamp: string;
  hasEnv: boolean;
  dbOk?: boolean;
  dbError?: string | null;
};

/**
 * ประกอบ payload health จากผลตรวจ + validate ด้วย zod
 * แยกออกมาเพื่อ unit test ได้โดยไม่ต้องมี Supabase/network
 */
export function buildHealthPayload(args: BuildArgs): HealthPayload {
  const { timestamp, hasEnv, dbOk, dbError } = args;

  let payload: HealthPayload;

  if (!hasEnv) {
    payload = {
      status: "degraded",
      timestamp,
      checks: { env: false, database: "skipped" },
      message: "ยังไม่ได้ตั้งค่า Supabase env (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)",
    };
  } else {
    payload = {
      status: dbOk ? "ok" : "degraded",
      timestamp,
      checks: {
        env: true,
        database: dbOk ? "connected" : "unreachable",
        ...(dbError ? { databaseError: dbError } : {}),
      },
    };
  }

  // validate ก่อนส่งออก — ถ้าผิดรูปจะ throw (จับได้ตอน dev/test)
  return healthPayloadSchema.parse(payload);
}
