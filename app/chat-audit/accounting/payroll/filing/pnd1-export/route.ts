import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { getFilingPeriodById, getFilingPeriodEmployeeTotals } from "@/lib/accounting/payroll-monthly-filing";
import { buildPnd1Report, buildPnd1Workbook } from "@/lib/accounting/payroll-pnd1-export";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_LABELS = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/**
 * GET /chat-audit/accounting/payroll/filing/pnd1-export?customerId=<uuid>&periodId=<uuid>
 *   ออกเอกสารสรุปยอดสำหรับยื่น ภ.ง.ด.1 (Excel) ของหน่วยยื่นเดือนนั้น — wishlist ข้อ 5
 *
 * สิทธิ์ (default deny): resolveAccountingAccess + customerInScope · tenantId จาก session
 * ★ IDOR-safe: derive scope จาก periodId ที่กำลังอ่านจริง (getFilingPeriodById) ไม่เชื่อ customerId
 *   ที่ client ส่งมาคู่กันลำพัง — เทียบ period.customerId ต้องตรงกับ customerId ที่ query มาด้วย
 * ★ ชื่อไฟล์ใช้รหัสลูกค้า+งวด (ASCII) ไม่ใส่ชื่อ/PII · ไม่ log เนื้อข้อมูลพนักงาน/เงินเดือน
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  const periodId = url.searchParams.get("periodId") ?? "";

  if (!getSupabaseEnv()) {
    return NextResponse.json({ error: "db_unavailable", message: "ยังไม่ได้ตั้งค่าฐานข้อมูล" }, { status: 503 });
  }
  if (!UUID_RE.test(customerId) || !UUID_RE.test(periodId)) {
    return NextResponse.json({ error: "invalid_params", message: "ต้องระบุลูกค้าและงวดยื่นให้ถูกต้อง" }, { status: 400 });
  }

  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const access = await resolveAccountingAccess(authed, service);
    if (!access) {
      return NextResponse.json({ error: "forbidden", message: "ไม่มีสิทธิ์ออกรายงาน" }, { status: 403 });
    }
    if (!customerInScope(access, customerId)) {
      return NextResponse.json(
        { error: "forbidden", message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" },
        { status: 403 }
      );
    }

    const period = await getFilingPeriodById(service, access.tenantId, periodId);
    if (!period || period.customerId !== customerId) {
      return NextResponse.json({ error: "not_found", message: "ไม่พบงวดยื่นภาษีนี้" }, { status: 404 });
    }

    const totals = await getFilingPeriodEmployeeTotals(service, access.tenantId, customerId, periodId);
    const report = buildPnd1Report(totals);

    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name, tax_id")
      .eq("id", customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    const c = (cust as { customer_code: string | null; name: string | null; tax_id: string | null } | null) ?? null;
    const entityLabel = [c?.customer_code, c?.name].filter(Boolean).join(" · ") || "กิจการ";
    const periodLabel = `${MONTH_LABELS[period.periodMonth] ?? ""} ${period.periodYear}`;

    const body = await buildPnd1Workbook(report, {
      entityLabel,
      periodLabel,
      payerTaxId: c?.tax_id ?? null,
    });

    const codePart = c?.customer_code ? c.customer_code.replace(/[^\w.-]/g, "") : customerId.slice(0, 8);
    const filename = `pnd1_${codePart}_${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}.xlsx`;

    return new NextResponse(body as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": XLSX_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "server_error", message: "ออกไฟล์สรุปยื่น ภ.ง.ด.1 ไม่สำเร็จ" }, { status: 500 });
  }
}
