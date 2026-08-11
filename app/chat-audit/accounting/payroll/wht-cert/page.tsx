import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope, type AccountingAccess } from "@/lib/accounting/access";
import { listEmployees, maskIdCardNo } from "@/lib/accounting/payroll-employees";
import { buildPayrollWhtCertData, type PayrollWhtCertRunLine } from "@/lib/accounting/payroll-wht-cert";
import { chunkIds } from "@/lib/accounting/id-chunk";
import PayrollWhtCertDoc from "./PayrollWhtCertDoc";
import "../../wht-cert/wht-cert.css";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /chat-audit/accounting/payroll/wht-cert — "หนังสือรับรองหัก ณ ที่จ่ายพนักงาน" (50 ทวิ, เฟส 9b กลุ่ม BD)
 *
 * เลือกลูกค้า → เลือกพนักงาน + ปีภาษี (พ.ศ.) → พรีวิว/พิมพ์ — รวมยอดเงินได้/ภาษีหัก ณ ที่จ่ายทุกเดือนของ
 *   ปีภาษีนั้นจาก `payroll_run_lines` ของนายจ้างปัจจุบัน (Finovas ทำเงินเดือนให้) + แสดงยอดยกมาจากนายจ้างเดิม
 *   (ถ้ามี) เป็นบรรทัดอ้างอิงแยกต่างหาก **ไม่บวกรวมเป็นยอดเดียว** (0.4)
 *
 * ★ guard: resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 * ★ print-only: ไม่บันทึกลง DB / ไม่มี migration ใหม่ / ไม่ auto-number
 * ★ PDPA (0.12): รายชื่อพนักงานสำหรับ dropdown ส่งเฉพาะ id/full_name/employee_code (ไม่ส่งเลขบัตร/ยอดเงิน
 *   ของพนักงานทุกคนลง client) — เลขบัตรเต็มของพนักงานที่เลือกจะมาสก์ไว้ก่อนเสมอ ต้องกดปุ่ม "เผยเลขเต็ม"
 *   (เรียก revealIdCardAction เดิมจากหน้าทะเบียนพนักงาน) ก่อนพิมพ์จริงถ้าต้องใช้เลขเต็ม
 */

function customerLabel(code: string | null, name: string | null): string {
  if (code && name) return `${code} · ${name}`;
  if (code) return code;
  if (name) return name;
  return "ลูกค้า";
}

async function fetchScopedCustomers(
  service: SupabaseClient,
  access: AccountingAccess
): Promise<{ id: string; label: string }[]> {
  let q = service
    .from("customers")
    .select("id, customer_code, name")
    .eq("tenant_id", access.tenantId)
    .is("deleted_at", null)
    .order("customer_code", { ascending: true, nullsFirst: false })
    .limit(5000);
  if (access.allowedCustomerIds !== null) {
    const ids = [...access.allowedCustomerIds];
    if (ids.length === 0) return [];
    q = q.in("id", ids);
  }
  const { data } = await q;
  const rows = (data ?? []) as { id: string; customer_code: string | null; name: string | null }[];
  return rows.map((c) => ({ id: c.id, label: customerLabel(c.customer_code, c.name) }));
}

function currentBuddhistYear(): number {
  return new Date().getFullYear() + 543;
}

/** ★ payroll_runs ต่อปีของลูกค้าหนึ่งราย ปกติมีไม่เกิน 12 รอบ/ปีสำหรับลูกค้า pay_frequency='monthly' แต่หลัง
 *   เฟส 9b กลุ่ม BC เปิดให้ลูกค้าตั้งค่า pay_frequency='non_monthly' ได้แล้ว (จ่ายรายสัปดาห์/รายปักษ์ ฯลฯ)
 *   จำนวนรอบ/ปีของลูกค้ากลุ่มนี้ไม่มีเพดานตายตัวอีกต่อไป (เช่น จ่ายทุกสัปดาห์ = ~52 รอบ/ปี, ถี่กว่านั้นอาจเกิน
 *   150 รอบ) — ต้องผ่าน chunkIds() เหมือนทุกจุดอื่นในโปรเจกต์ กัน `.in("run_id", ids)` ยาวเกิน limit ของ
 *   PostgREST แล้วถูกปฏิเสธเงียบ ๆ (ยอด 50 ทวิ จะขาดโดยไม่มี error ใดๆ ให้เห็น — ดูคอมเมนต์ chunkIds() ในไฟล์
 *   lib/accounting/id-chunk.ts) */
async function loadRunLinesOfYear(
  service: SupabaseClient,
  tenantId: string,
  customerId: string,
  employeeId: string,
  taxYear: number
): Promise<PayrollWhtCertRunLine[]> {
  const { data: runs } = await service
    .from("payroll_runs")
    .select("id, pay_period_month")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .eq("pay_period_year", taxYear)
    .is("deleted_at", null);
  const runRows = (runs ?? []) as { id: string; pay_period_month: number }[];
  if (runRows.length === 0) return [];
  const monthByRunId = new Map(runRows.map((r) => [r.id, r.pay_period_month]));

  const lineChunks = await Promise.all(
    chunkIds(runRows.map((r) => r.id)).map((chunk) =>
      service
        .from("payroll_run_lines")
        .select("run_id, gross_salary, other_additions, bonus_amount, pit_withheld")
        .eq("tenant_id", tenantId)
        .eq("payroll_employee_id", employeeId)
        .in("run_id", chunk)
    )
  );
  const lineRows = lineChunks.flatMap(
    ({ data }) =>
      (data ?? []) as {
        run_id: string;
        gross_salary: number | string;
        other_additions: number | string;
        bonus_amount: number | string;
        pit_withheld: number | string;
      }[]
  );

  return lineRows
    .filter((l) => monthByRunId.has(l.run_id))
    .map((l) => ({
      payPeriodYear: taxYear,
      payPeriodMonth: monthByRunId.get(l.run_id)!,
      grossSalary: Number(l.gross_salary) || 0,
      otherAdditions: Number(l.other_additions) || 0,
      bonusAmount: Number(l.bonus_amount) || 0,
      pitWithheld: Number(l.pit_withheld) || 0,
    }));
}

export default async function PayrollWhtCertPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; employeeId?: string; taxYear?: string }>;
}) {
  const sp = await searchParams;

  if (!getSupabaseEnv()) {
    return (
      <div className="whtc-shell">
        <div className="whtc-error">ยังไม่ได้ตั้งค่าฐานข้อมูล (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY)</div>
      </div>
    );
  }

  const authed = await createClient();
  const service = createServiceRoleClient();
  const access = await resolveAccountingAccess(authed, service);
  if (!access) redirect("/login?redirect=/chat-audit/accounting");

  const tenantId = access.tenantId;
  const customers = await fetchScopedCustomers(service, access);

  const rawCustomer = (sp.customerId ?? "").trim();
  const validCustomerId =
    UUID_RE.test(rawCustomer) && customers.some((c) => c.id === rawCustomer) ? rawCustomer : "";

  if (!validCustomerId) {
    return (
      <ChooserShell customers={customers} selectedCustomerId="" employees={[]} selectedEmployeeId="" taxYear={currentBuddhistYear()} />
    );
  }
  if (!customerInScope(access, validCustomerId)) {
    return (
      <div className="whtc-shell">
        <div className="whtc-error">ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ</div>
      </div>
    );
  }

  const employees = await listEmployees(service, tenantId, validCustomerId);
  const employeeOptions = employees.map((e) => ({ id: e.id, fullName: e.fullName, employeeCode: e.employeeCode }));

  const rawEmployee = (sp.employeeId ?? "").trim();
  const validEmployeeId = UUID_RE.test(rawEmployee) && employees.some((e) => e.id === rawEmployee) ? rawEmployee : "";

  const taxYear = Number.isFinite(Number(sp.taxYear)) && Number(sp.taxYear) > 0 ? Number(sp.taxYear) : currentBuddhistYear();

  if (!validEmployeeId) {
    return (
      <ChooserShell
        customers={customers}
        selectedCustomerId={validCustomerId}
        employees={employeeOptions}
        selectedEmployeeId=""
        taxYear={taxYear}
      />
    );
  }

  const employee = employees.find((e) => e.id === validEmployeeId)!;

  const { data: custRow } = await service
    .from("customers")
    .select("id, name, business_name, tax_id")
    .eq("id", validCustomerId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  const cust = custRow as { id: string; name: string | null; business_name: string | null; tax_id: string | null } | null;

  let customerAddress = "";
  try {
    const { data, error } = await service
      .from("customers")
      .select("address")
      .eq("id", validCustomerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!error) customerAddress = (data as { address: string | null } | null)?.address ?? "";
  } catch {
    // คอลัมน์ยังไม่ apply → ปล่อยว่าง
  }

  const runLines = await loadRunLinesOfYear(service, tenantId, validCustomerId, validEmployeeId, taxYear);
  const certData = buildPayrollWhtCertData(
    taxYear,
    runLines,
    {
      gross: employee.priorEmployerYtdGross,
      pitWithheld: employee.priorEmployerYtdPitWithheld,
      ssoEmployee: employee.priorEmployerYtdSsoEmployee,
      note: employee.priorEmployerNote,
    }
  );

  return (
    <div className="whtc-shell">
      <ChooserBar
        customers={customers}
        selectedCustomerId={validCustomerId}
        employees={employeeOptions}
        selectedEmployeeId={validEmployeeId}
        taxYear={taxYear}
      />
      <PayrollWhtCertDoc
        payerName={(cust?.business_name || cust?.name || "").trim()}
        payerTaxId={cust?.tax_id ?? ""}
        payerAddress={customerAddress}
        employeeId={validEmployeeId}
        customerId={validCustomerId}
        employeeFullName={employee.fullName}
        employeeIdCardNoMasked={maskIdCardNo(employee.idCardNo)}
        certData={certData}
        backHref={`/chat-audit/accounting/payroll?customerId=${validCustomerId}`}
      />
    </div>
  );
}

/** ฟอร์มเลือกลูกค้า/พนักงาน/ปีภาษี (แสดงตอนยังเลือกไม่ครบ) */
function ChooserShell({
  customers,
  selectedCustomerId,
  employees,
  selectedEmployeeId,
  taxYear,
}: {
  customers: { id: string; label: string }[];
  selectedCustomerId: string;
  employees: { id: string; fullName: string; employeeCode: string | null }[];
  selectedEmployeeId: string;
  taxYear: number;
}) {
  return (
    <div className="whtc-shell">
      <ChooserBar
        customers={customers}
        selectedCustomerId={selectedCustomerId}
        employees={employees}
        selectedEmployeeId={selectedEmployeeId}
        taxYear={taxYear}
      />
      <div className="whtc-error">
        <p>เลือกลูกค้าและพนักงานด้านบนเพื่อพรีวิวหนังสือรับรองหัก ณ ที่จ่าย</p>
        <a href="/chat-audit/accounting/payroll" className="whtc-btn">← กลับหน้ารอบเงินเดือน</a>
      </div>
    </div>
  );
}

/** แถบเลือกลูกค้า/พนักงาน/ปีภาษี (ซ่อนตอนพิมพ์) */
function ChooserBar({
  customers,
  selectedCustomerId,
  employees,
  selectedEmployeeId,
  taxYear,
}: {
  customers: { id: string; label: string }[];
  selectedCustomerId: string;
  employees: { id: string; fullName: string; employeeCode: string | null }[];
  selectedEmployeeId: string;
  taxYear: number;
}) {
  return (
    <form method="get" className="whtc-toolbar no-print" style={{ flexWrap: "wrap", gap: 10 }}>
      <a href="/chat-audit/accounting/payroll" className="whtc-btn whtc-btn-ghost">← กลับ</a>
      <label>
        ลูกค้า:{" "}
        <select name="customerId" defaultValue={selectedCustomerId} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
          <option value="">— เลือกลูกค้า —</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </label>
      <label>
        พนักงาน:{" "}
        <select name="employeeId" defaultValue={selectedEmployeeId}>
          <option value="">— เลือกพนักงาน —</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.fullName}{e.employeeCode ? ` (${e.employeeCode})` : ""}</option>
          ))}
        </select>
      </label>
      <label>
        ปีภาษี (พ.ศ.):{" "}
        <input name="taxYear" type="number" defaultValue={taxYear} style={{ width: 90 }} />
      </label>
      <button type="submit" className="whtc-btn whtc-btn-primary">แสดง</button>
    </form>
  );
}
