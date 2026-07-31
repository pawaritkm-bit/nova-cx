import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess } from "@/lib/accounting/access";
import { customerIdsForAccountant } from "@/lib/accounting/accountant-scope";
import { listEntries, type EntryType, type ListEntriesFilter } from "@/lib/accounting/queries";
import { buildBillEntriesWorkbook } from "@/lib/accounting/excel";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /chat-audit/accounting/export?customerId=<uuid>&month=YYYY-MM&type=purchase|sale
 *   Export รายงานภาษีซื้อ/ขายเป็นไฟล์ .xlsx จริง (2 ชีท: ภาษีซื้อ/ภาษีขาย)
 *   - customerId (optional) → รายงานของลูกค้ารายนั้น (แต่ละลูกค้ายื่นภาษีแยกกัน)
 *   - month (optional)      → กรองเฉพาะเดือน
 *   - type (optional)       → กรองเฉพาะประเภท (ปกติไม่ใส่ = ทั้งซื้อและขาย)
 *
 * สิทธิ์ (default deny): ต้อง login + role∈{admin,executive} มิฉะนั้น 401/403
 * ★ tenantId มาจาก session (ไม่เชื่อ client) · ไม่ log เนื้อบิล/ชื่อลูกค้า
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  const accountant = url.searchParams.get("accountant") ?? "";
  const month = url.searchParams.get("month") ?? "";
  const type = url.searchParams.get("type") ?? "";

  if (!getSupabaseEnv()) {
    return NextResponse.json(
      { error: "db_unavailable", message: "ยังไม่ได้ตั้งค่าฐานข้อมูล" },
      { status: 503 }
    );
  }

  // validate param (กัน injection/ค่าเพี้ยน)
  if (customerId && !UUID_RE.test(customerId)) {
    return NextResponse.json({ error: "invalid_params", message: "ลูกค้าไม่ถูกต้อง" }, { status: 400 });
  }
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : "";
  const validType: EntryType | "" =
    type === "purchase" || type === "sale" ? (type as EntryType) : "";

  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const access = await resolveAccountingAccess(authed, service);
    if (!access) {
      return NextResponse.json({ error: "forbidden", message: "ไม่มีสิทธิ์ออกรายงาน" }, { status: 403 });
    }

    const filter: ListEntriesFilter = {};
    if (validMonth) filter.month = validMonth;
    if (validType) filter.entryType = validType;

    // ---- สโคปลูกค้า (server-side enforce) ----
    if (access.allowedCustomerIds !== null) {
      // นักบัญชี: จำกัดเฉพาะลูกค้าที่ตัวเองดูแล
      if (customerId) {
        if (!access.allowedCustomerIds.has(customerId)) {
          return NextResponse.json(
            { error: "forbidden", message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" },
            { status: 403 }
          );
        }
        filter.customerId = customerId;
      } else {
        filter.customerIds = [...access.allowedCustomerIds];
      }
    } else {
      // admin/lead: ตามลูกค้าที่ระบุ หรือ สโคปตามนักบัญชีที่เลือก (ถ้ามี) ไม่งั้นทั้งสำนักงาน
      if (customerId) {
        filter.customerId = customerId;
      } else if (UUID_RE.test(accountant)) {
        filter.customerIds = await customerIdsForAccountant(service, access.tenantId, accountant);
      }
    }

    const { entries } = await listEntries(service, access.tenantId, filter);
    const xlsx = await buildBillEntriesWorkbook(entries);

    // ชื่อไฟล์ไทย: ใส่รหัสลูกค้า (ไม่ใช่ชื่อ — PDPA) ถ้าเป็นรายลูกค้า
    let codePart = "";
    if (customerId) {
      const { data: cust } = await service
        .from("customers")
        .select("customer_code")
        .eq("id", customerId)
        .eq("tenant_id", access.tenantId)
        .maybeSingle();
      const code = (cust as { customer_code?: string | null } | null)?.customer_code;
      codePart = code ? `-${code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    }
    const monthPart = validMonth || "ทั้งหมด";
    const filename = `ภาษีซื้อขาย${codePart}-${monthPart}.xlsx`;
    // RFC5987: filename* รองรับ UTF-8 (ชื่อไทย) + ascii fallback กัน client เก่า
    const asciiFallback = `tax-report${codePart || ""}-${monthPart.replace(/[^\w.-]/g, "")}.xlsx`;

    return new NextResponse(xlsx as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": XLSX_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "server_error", message: "ออกรายงานไม่สำเร็จ" },
      { status: 500 }
    );
  }
}
