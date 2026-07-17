/**
 * Zod schemas สำหรับหน้า Admin (จัดการข้อมูลจริง)
 * - validate อินพุตทุกฟอร์มก่อนเขียน DB (กันค่าว่าง/ผิดรูปแบบ/ค่านอก enum)
 * - ค่า enum ตรงกับ CHECK constraint ใน migration จริง (0003/0004/0005)
 *   teams.type            in ('accounting','sales','cs')
 *   employees.employee_type in ('accountant','sales','cs','other')
 *   customer_assignments.role / team_members.role_in_team in ('lead','member','coordinator')
 */
import { z } from "zod";

/** แปลง string ว่าง/space → undefined (ฟิลด์ optional จาก FormData มักเป็น "") */
const emptyToUndef = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

/** ข้อความสั้น ๆ บังคับกรอก (trim แล้วต้องมีอย่างน้อย 1 ตัวอักษร) */
const requiredText = (label: string) =>
  z
    .string({ required_error: `กรุณากรอก${label}` })
    .trim()
    .min(1, `กรุณากรอก${label}`)
    .max(200, `${label}ยาวเกินไป (ไม่เกิน 200 ตัวอักษร)`);

/** ข้อความ optional (ตัดช่องว่าง, ว่าง = undefined) */
const optionalText = z.preprocess(
  emptyToUndef,
  z.string().trim().max(200, "ข้อความยาวเกินไป").optional()
);

/** uuid optional (ว่าง = undefined) */
const optionalUuid = z.preprocess(
  emptyToUndef,
  z.string().uuid("รหัสอ้างอิงไม่ถูกต้อง").optional()
);

/** วันที่รูปแบบ YYYY-MM-DD (จาก <input type="date">) */
const optionalDate = z.preprocess(
  emptyToUndef,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "รูปแบบวันที่ไม่ถูกต้อง")
    .optional()
);

// ---- ประเภท/บทบาท (enum ตรง DB) --------------------------------------
export const TEAM_TYPES = ["accounting", "sales", "cs"] as const;
export const EMPLOYEE_TYPES = ["accountant", "sales", "cs", "other"] as const;
export const ASSIGNMENT_ROLES = ["lead", "member", "coordinator"] as const;

// ---- ฟอร์ม 1: ทีมบัญชี ----------------------------------------------
export const createTeamSchema = z.object({
  name: requiredText("ชื่อทีม"),
  type: z.enum(TEAM_TYPES, { errorMap: () => ({ message: "เลือกประเภททีม" }) }),
  lead_employee_id: optionalUuid, // หัวหน้าทีม (optional)
});
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

// ---- ฟอร์ม 2: พนักงาน (นักบัญชี/เซล) --------------------------------
export const createEmployeeSchema = z.object({
  first_name: requiredText("ชื่อ-นามสกุล"),
  nickname: optionalText,
  position: optionalText,
  employee_type: z.enum(EMPLOYEE_TYPES, {
    errorMap: () => ({ message: "เลือกประเภทพนักงาน" }),
  }),
  // checkbox ส่ง "on"/undefined; แปลงเป็น boolean (default = active)
  is_active: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
  team_id: optionalUuid, // ผูกเข้าทีมทันที (optional)
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

// ---- ฟอร์ม 3: ลูกค้า -------------------------------------------------
export const createCustomerSchema = z.object({
  customer_code: optionalText,
  name: requiredText("ชื่อลูกค้า"),
  business_name: optionalText,
  service_start_date: optionalDate,
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

// ---- ฟอร์ม 4: มอบหมาย (ลูกค้า → นักบัญชี) ---------------------------
export const createAssignmentSchema = z.object({
  customer_id: z.string().uuid("กรุณาเลือกลูกค้า"),
  employee_id: z.string().uuid("กรุณาเลือกพนักงาน"),
  role: z.enum(ASSIGNMENT_ROLES, {
    errorMap: () => ({ message: "เลือกบทบาทผู้ดูแล" }),
  }),
  team_id: optionalUuid,
});
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;

/** ดึงข้อความ error แรกจาก ZodError (แสดงต่อผู้ใช้แบบสุภาพ) */
export function firstZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง";
}
