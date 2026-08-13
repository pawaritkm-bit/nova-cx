/**
 * ส่งสลิปเงินเดือนเป็น PDF ทางอีเมลให้พนักงานทุกคนในรอบ 1 รอบ (wishlist ข้อ 6)
 *
 * ★ ผู้เรียก (action) ต้อง resolveAccountingAccess/requireAccountingAccess + assertCustomerInScope +
 *   derive scope จาก runId (getRunScope) มาก่อนเรียกฟังก์ชันนี้เสมอ (IDOR-safe, มิเรอร์ทุก action อื่นในเฟสนี้)
 *   — ฟังก์ชันนี้ไม่ตรวจสิทธิ์ซ้ำ
 * ★ per-employee try/catch — คนหนึ่งสร้าง PDF พัง/ส่งอีเมลไม่สำเร็จ ไม่บล็อกคนอื่นในชุดเดียวกัน (0.1,
 *   มิเรอร์ pattern batch เดิมทุกจุดในเฟสนี้)
 * ★ ไม่เขียนอ่าน (id,email) ผ่าน fetchEmployeeInfo ภายใน payroll.ts (ใช้ร่วมกับ path โหลดหน้ารอบเงินเดือนหลัก)
 *   — เลี่ยงเสี่ยงกระทบพฤติกรรมเดิม แยก query เล็ก ๆ เฉพาะไฟล์นี้แทน
 * ★ PDPA: ไม่ log email address/ชื่อพนักงานที่นี่
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkIds } from "@/lib/accounting/id-chunk";
import { getRunWithLines } from "@/lib/accounting/payroll";
import { buildPayslipPdfBuffer, buildPayslipEmailContent, payslipFilename } from "@/lib/accounting/payroll-payslip-pdf";
import { sendEmail } from "@/lib/email/mailer";

type DB = SupabaseClient;

export type PayslipEmailStatus = "sent" | "skipped_no_email" | "failed";

export type PayslipEmailResult = {
  payrollEmployeeId: string;
  employeeFullName: string;
  status: PayslipEmailStatus;
  message?: string;
};

export type SendPayslipEmailsResult = { ok: true; results: PayslipEmailResult[] } | { ok: false; message: string };

async function loadEmployeeEmails(db: DB, tenantId: string, ids: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const chunks = await Promise.all(
    chunkIds(ids).map((chunk) => db.from("payroll_employees").select("id, email").eq("tenant_id", tenantId).in("id", chunk))
  );
  for (const { data } of chunks) {
    for (const row of (data ?? []) as Array<{ id: string; email: string | null }>) {
      map.set(row.id, row.email ?? null);
    }
  }
  return map;
}

/** ส่งสลิปเงินเดือนเป็น PDF ทางอีเมลทั้งรอบ — คืนผลรายพนักงาน (sent/skipped_no_email/failed) ไม่ throw */
export async function sendPayslipEmails(
  db: DB,
  tenantId: string,
  customerId: string,
  runId: string
): Promise<SendPayslipEmailsResult> {
  const loaded = await getRunWithLines(db, tenantId, customerId, runId);
  if (!loaded) return { ok: false, message: "ไม่พบรอบเงินเดือน (อาจถูกลบไปแล้ว)" };
  const { run, lines } = loaded;
  if (lines.length === 0) return { ok: false, message: "รอบนี้ยังไม่มีบรรทัดพนักงาน" };

  const emailByEmployeeId = await loadEmployeeEmails(
    db,
    tenantId,
    lines.map((l) => l.payrollEmployeeId)
  );

  const results: PayslipEmailResult[] = [];
  for (const line of lines) {
    const email = emailByEmployeeId.get(line.payrollEmployeeId) ?? null;
    if (!email) {
      results.push({ payrollEmployeeId: line.payrollEmployeeId, employeeFullName: line.employeeFullName, status: "skipped_no_email" });
      continue;
    }
    try {
      const pdf = await buildPayslipPdfBuffer(run, line);
      const { subject, text } = buildPayslipEmailContent(run, line);
      const sendRes = await sendEmail({
        to: email,
        subject,
        text,
        attachments: [{ filename: payslipFilename(run, line), content: pdf }],
      });
      results.push(
        sendRes.ok
          ? { payrollEmployeeId: line.payrollEmployeeId, employeeFullName: line.employeeFullName, status: "sent" }
          : {
              payrollEmployeeId: line.payrollEmployeeId,
              employeeFullName: line.employeeFullName,
              status: "failed",
              message: sendRes.message,
            }
      );
    } catch {
      results.push({
        payrollEmployeeId: line.payrollEmployeeId,
        employeeFullName: line.employeeFullName,
        status: "failed",
        message: "สร้าง/ส่งสลิปไม่สำเร็จ",
      });
    }
  }

  return { ok: true, results };
}
