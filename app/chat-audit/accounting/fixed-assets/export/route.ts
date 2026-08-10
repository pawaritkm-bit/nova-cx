import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listAssets, netBookValue, type FixedAsset } from "@/lib/accounting/fixed-assets";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_FMT = "#,##0.00";

function statusLabel(a: FixedAsset): string {
  if (a.status === "disposed") return "จำหน่ายแล้ว";
  return a.nextDepDate ? "ใช้งานอยู่" : "ตัดค่าเสื่อมครบแล้ว";
}

/** วันที่แบบไทย วว/ดด/ปปปป (พ.ศ.) — ใช้แสดงในรายงาน Excel */
function formatDateThai(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso ?? "—";
}

/** สร้าง workbook เดียว: ทะเบียนทรัพย์สินถาวร + ค่าเสื่อมสะสม/NBV/สถานะ (mirror budget/export/route.ts pattern) */
function buildFixedAssetsWorkbook(
  rows: FixedAsset[],
  header: { entityLabel: string }
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ทะเบียนทรัพย์สิน");
  ws.addRow(["ทะเบียนทรัพย์สินถาวร"]).font = { bold: true, size: 14 };
  ws.addRow([header.entityLabel]);
  ws.addRow([]);
  const headRow = ws.addRow([
    "ชื่อทรัพย์สิน",
    "วันที่ซื้อ",
    "ราคาทุน",
    "มูลค่าซาก",
    "อายุการใช้งาน (เดือน)",
    "ค่าเสื่อมสะสม",
    "มูลค่าตามบัญชี (NBV)",
    "รอบถัดไป",
    "สถานะ",
  ]);
  headRow.font = { bold: true };
  headRow.alignment = { vertical: "middle", horizontal: "center" };

  let totalCost = 0;
  let totalAccum = 0;
  let totalNbv = 0;
  for (const a of rows) {
    const nbv = netBookValue(a);
    ws.addRow([
      a.name,
      formatDateThai(a.acquisitionDate),
      a.cost,
      a.salvageValue,
      a.usefulLifeMonths,
      a.accumulatedDepreciation,
      nbv,
      a.nextDepDate ? formatDateThai(a.nextDepDate) : "—",
      statusLabel(a),
    ]);
    totalCost += a.cost;
    totalAccum += a.accumulatedDepreciation;
    totalNbv += nbv;
  }
  const total = ws.addRow(["รวมทั้งสิ้น", "", totalCost, "", "", totalAccum, totalNbv, "", ""]);
  total.font = { bold: true };

  ws.columns.forEach((c, i) => (c.width = [26, 14, 16, 14, 18, 16, 18, 14, 16][i] ?? 14));
  [3, 4, 6, 7].forEach((col) => (ws.getColumn(col).numFmt = NUMBER_FMT));

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/**
 * GET /chat-audit/accounting/fixed-assets/export?customerId=<uuid>
 *   Export ทะเบียนทรัพย์สินถาวร (ชื่อ/ราคาทุน/ค่าเสื่อมสะสม/NBV/สถานะ) ของลูกค้า 1 ราย เป็นไฟล์ .xlsx (T64)
 *
 * สิทธิ์ (default deny): resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 * ★ tenantId จาก session (ไม่เชื่อ client) · ไม่ log ชื่อทรัพย์สิน/ตัวเลข/ชื่อลูกค้า
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId") ?? "";

  if (!getSupabaseEnv()) {
    return NextResponse.json({ error: "db_unavailable", message: "ยังไม่ได้ตั้งค่าฐานข้อมูล" }, { status: 503 });
  }
  if (!UUID_RE.test(customerId)) {
    return NextResponse.json({ error: "invalid_params", message: "ต้องระบุลูกค้า" }, { status: 400 });
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

    const assets = await listAssets(service, access.tenantId, customerId);

    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name")
      .eq("id", customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    const c = (cust as { customer_code: string | null; name: string | null } | null) ?? null;
    const entityLabel = [c?.customer_code, c?.name].filter(Boolean).join(" · ") || "กิจการ";

    const xlsx = await buildFixedAssetsWorkbook(assets, { entityLabel });

    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const filename = `ทะเบียนทรัพย์สิน${codePart}.xlsx`;
    const asciiFallback = `fixed-assets${codePart}.xlsx`;

    return new NextResponse(xlsx as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": XLSX_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "server_error", message: "ออกรายงานไม่สำเร็จ" }, { status: 500 });
  }
}
