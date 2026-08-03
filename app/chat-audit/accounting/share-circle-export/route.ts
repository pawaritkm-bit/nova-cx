import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listShareCircleEntries } from "@/lib/share-circles/queries";
import { buildShareCircleSbtWorkbook } from "@/lib/accounting/share-circle-excel";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /chat-audit/accounting/share-circle-export?customerId=<uuid>&month=YYYY-MM
 *   Export "ยื่น ภธ.40" ของลูกค้า(ท้าว) เป็นไฟล์ .xlsx (สรุปรายเดือน + รวมทั้งปี)
 *   - month (optional) → เฉพาะเดือนนั้น (ไม่ใส่ = ทุกเดือน)
 *
 * สิทธิ์ (default deny): ต้อง login + สิทธิ์บัญชี + ลูกค้าอยู่ในสโคป
 * ★ tenantId มาจาก session · ไม่ log เนื้อวง/ชื่อลูกค้า
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  const month = url.searchParams.get("month") ?? "";

  if (!getSupabaseEnv()) {
    return NextResponse.json(
      { error: "db_unavailable", message: "ยังไม่ได้ตั้งค่าฐานข้อมูล" },
      { status: 503 }
    );
  }
  if (!UUID_RE.test(customerId)) {
    return NextResponse.json({ error: "invalid_params", message: "ลูกค้าไม่ถูกต้อง" }, { status: 400 });
  }
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : "";

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

    const entries = await listShareCircleEntries(service, {
      tenantId: access.tenantId,
      customerId,
      month: validMonth || undefined,
    });
    const xlsx = await buildShareCircleSbtWorkbook(entries);

    // ชื่อไฟล์: ใส่รหัสลูกค้า (ไม่ใช่ชื่อ — PDPA)
    const { data: cust } = await service
      .from("customers")
      .select("customer_code")
      .eq("id", customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    const code = (cust as { customer_code?: string | null } | null)?.customer_code;
    const codePart = code ? `-${code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const monthPart = validMonth || "ทั้งหมด";
    const filename = `ภธ40-วงแชร์${codePart}-${monthPart}.xlsx`;
    const asciiFallback = `sbt-share-circle${codePart}-${monthPart.replace(/[^\w.-]/g, "")}.xlsx`;

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
      { error: "server_error", message: "ออกรายงานไม่สำเร็จ (อาจยังไม่ได้ apply migration 0057)" },
      { status: 500 }
    );
  }
}
