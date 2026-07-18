/**
 * Zod schemas ของหน้า "ตั้งค่าตรวจแชต" (admin) — Phase 5b
 *   - จับคู่กลุ่ม→ลูกค้า / สมาชิก→พนักงาน
 *   - น้ำหนักคะแนน 8 มิติ (รวม = 100)
 *   - SLA rules (CRUD)
 * ★ validate ทุก input ก่อนเขียน DB (ค่า enum ตรง CHECK ใน migration 0032/0034/0035)
 */
import { z } from "zod";
import { DIMENSIONS } from "@/lib/evaluation/weights";

const emptyToUndef = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const emptyToNull = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? null : v;

/** จำนวนเต็มบวก (นาที SLA) จาก string ในฟอร์ม — ว่าง = null */
const optionalPositiveInt = z.preprocess(
  emptyToNull,
  z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? Number(v) : v))
    .refine((n) => Number.isInteger(n) && n >= 0 && n <= 100000, "เวลา (นาที) ไม่ถูกต้อง")
    .nullable()
);

// ---- 1) จับคู่กลุ่ม → ลูกค้า -----------------------------------------
export const mapGroupSchema = z.object({
  chat_group_id: z.string().uuid("ไม่พบกลุ่มที่เลือก"),
  // customer_id ว่าง = ยกเลิกการจับคู่ (null); ไม่ว่าง = uuid
  customer_id: z.preprocess(
    emptyToNull,
    z.string().uuid("กรุณาเลือกลูกค้า").nullable()
  ),
});
export type MapGroupInput = z.infer<typeof mapGroupSchema>;

// ---- 2) จับคู่สมาชิก → พนักงาน / ระบุบทบาท --------------------------
export const MEMBER_KINDS = ["customer", "accountant", "lead", "system", "unknown"] as const;
export const setMemberSchema = z
  .object({
    chat_member_id: z.string().uuid("ไม่พบสมาชิกที่เลือก"),
    member_kind: z.enum(MEMBER_KINDS, {
      errorMap: () => ({ message: "เลือกบทบาทสมาชิก" }),
    }),
    // ผูกกับพนักงาน (เฉพาะ accountant/lead); ว่าง = null
    employee_id: z.preprocess(
      emptyToNull,
      z.string().uuid("รหัสพนักงานไม่ถูกต้อง").nullable()
    ),
  })
  .refine(
    // ถ้าเป็น customer/system/unknown → ไม่ควรผูกพนักงาน (กันข้อมูลขัดกัน)
    (v) => (v.member_kind === "accountant" || v.member_kind === "lead" ? true : v.employee_id === null),
    { message: "บทบาทนี้ไม่ต้องผูกกับพนักงาน", path: ["employee_id"] }
  )
  .refine(
    // ★ นักบัญชี/หัวหน้า "ต้อง" ผูกกับพนักงาน (ไม่งั้นระบบไม่รู้ว่าใครตอบช้า/เร็ว) — L1
    (v) => (v.member_kind === "accountant" || v.member_kind === "lead" ? v.employee_id !== null : true),
    { message: "บทบาทนักบัญชี/หัวหน้า ต้องเลือกพนักงานที่ผูก", path: ["employee_id"] }
  );
export type SetMemberInput = z.infer<typeof setMemberSchema>;

// ---- 3) น้ำหนักคะแนน 8 มิติ (รวม = 100) -----------------------------
/** ค่าน้ำหนัก 1 มิติ (รับ number/string จากฟอร์ม → number 0-100) */
const weightValue = z.preprocess(
  (v) => (typeof v === "string" ? Number(v) : v),
  z.number({ invalid_type_error: "น้ำหนักต้องเป็นตัวเลข" }).min(0, "น้ำหนักติดลบไม่ได้").max(100, "น้ำหนักเกิน 100")
);

/** shape 8 มิติ (typed เป็น ZodRawShape) */
const weightsShape: z.ZodRawShape = {};
for (const d of DIMENSIONS) weightsShape[d] = weightValue;

/** schema รับค่า 8 มิติ (number/string) — validate รวม = 100 + ไม่ติดลบ */
export const saveWeightsSchema = z.object(weightsShape).refine(
  (obj) => {
    const sum = DIMENSIONS.reduce((s, d) => s + (Number((obj as Record<string, number>)[d]) || 0), 0);
    return Math.abs(sum - 100) < 0.01;
  },
  { message: "น้ำหนักรวมต้องเท่ากับ 100 พอดี" }
);
export type SaveWeightsInput = z.infer<typeof saveWeightsSchema>;

// ---- 4) SLA rules (CRUD) --------------------------------------------
export const URGENCY_VALUES = ["critical", "high", "medium", "low"] as const;

const optionalScopeText = z.preprocess(
  emptyToNull,
  z.string().trim().max(100, "ข้อความยาวเกินไป").nullable()
);

export const slaRuleSchema = z
  .object({
    name: z
      .string({ required_error: "กรุณากรอกชื่อเงื่อนไข" })
      .trim()
      .min(1, "กรุณากรอกชื่อเงื่อนไข")
      .max(120, "ชื่อยาวเกินไป"),
    customer_type: optionalScopeText,
    urgency: z.preprocess(
      emptyToNull,
      z.enum(URGENCY_VALUES).nullable()
    ),
    work_type: optionalScopeText,
    team_id: z.preprocess(emptyToUndef, z.string().uuid("ทีมไม่ถูกต้อง").optional()),
    first_response_minutes: optionalPositiveInt,
    resolution_minutes: optionalPositiveInt,
    priority: z.preprocess(
      (v) => (v === undefined || v === null || v === "" ? 100 : typeof v === "string" ? Number(v) : v),
      z.number().int("ลำดับความสำคัญต้องเป็นจำนวนเต็ม").min(0).max(1000)
    ),
    is_active: z.preprocess(
      (v) => v === "on" || v === "true" || v === true,
      z.boolean()
    ),
  })
  .refine(
    // ต้องกำหนดอย่างน้อย 1 ใน 2 เวลา (ไม่งั้น rule ไม่มีผล)
    (v) => v.first_response_minutes !== null || v.resolution_minutes !== null,
    { message: "กรุณากำหนดเวลาตอบครั้งแรก หรือเวลาปิดเคส อย่างน้อยหนึ่งอย่าง", path: ["first_response_minutes"] }
  );
export type SlaRuleInput = z.infer<typeof slaRuleSchema>;

export const updateSlaRuleSchema = z.object({
  id: z.string().uuid("ไม่พบเงื่อนไขที่เลือก"),
});

/** ดึงข้อความ error แรกจาก ZodError */
export function firstZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง";
}
