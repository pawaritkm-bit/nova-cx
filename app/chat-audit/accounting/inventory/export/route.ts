import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listProducts } from "@/lib/accounting/products";
import {
  listMovements,
  getProductOpeningBalance,
  computeStockLedger,
  buildStockCard,
  buildInventoryValuationReport,
  type StockCardRow,
  type ProductLedgerInput,
} from "@/lib/accounting/product-stock";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_FMT = "#,##0.00";
/** เพดานสินค้าที่คำนวณ ledger ต่อ 1 ครั้ง export (mirror page.tsx) */
const PRODUCT_LEDGER_LIMIT = 500;

/** วันที่แบบไทย วว/ดด/ปปปป (พ.ศ.) — '' (แถวยอดยกมา) → "ยอดยกมา" */
function formatDateThai(iso: string): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso;
}

/** ชีต 1: บัตรสต็อกของสินค้า 1 ตัว (mirror ตัวอย่างที่ผู้ใช้แนบ — วันที่/รายการรับ/รายการจ่าย/คงเหลือ/เอกสารอ้างอิง) */
function addStockCardSheet(wb: ExcelJS.Workbook, productName: string, entityLabel: string, rows: StockCardRow[]): void {
  const ws = wb.addWorksheet("บัตรสต็อก");
  ws.addRow([`บัตรสต็อก — ${productName}`]).font = { bold: true, size: 14 };
  ws.addRow([entityLabel]);
  ws.addRow([]);
  const head = ws.addRow([
    "วันที่",
    "รายการ",
    "อ้างอิง",
    "รับ (จำนวน)",
    "รับ (ราคา/หน่วย)",
    "รับ (มูลค่า)",
    "จ่าย (จำนวน)",
    "จ่าย (ราคา/หน่วย)",
    "จ่าย (มูลค่า)",
    "คงเหลือ (จำนวน)",
    "คงเหลือ (ราคา/หน่วย)",
    "คงเหลือ (มูลค่า)",
    "คำเตือน",
  ]);
  head.font = { bold: true };
  head.alignment = { vertical: "middle", horizontal: "center" };

  for (const r of rows) {
    ws.addRow([
      formatDateThai(r.date),
      r.docLabel,
      r.reference ?? "—",
      r.inQuantity ?? "",
      r.inUnitCost ?? "",
      r.inValue ?? "",
      r.outQuantity ?? "",
      r.outUnitCost ?? "",
      r.outValue ?? "",
      r.balanceQuantity,
      r.balanceUnitCost,
      r.balanceValue,
      r.negativeWarning ? "คงเหลือติดลบ" : "",
    ]);
  }

  ws.columns.forEach((c, i) => (c.width = [14, 14, 20, 12, 14, 14, 12, 14, 14, 14, 14, 14, 16][i] ?? 14));
  [4, 5, 6, 7, 8, 9, 10, 11, 12].forEach((col) => (ws.getColumn(col).numFmt = NUMBER_FMT));
}

/** ชีต 2: สินค้าคงเหลือแยกหมวด ณ วันนี้ (0.10) */
function addValuationSheet(
  wb: ExcelJS.Workbook,
  entityLabel: string,
  report: ReturnType<typeof buildInventoryValuationReport>
): void {
  const ws = wb.addWorksheet("สินค้าคงเหลือแยกหมวด");
  ws.addRow(["สินค้าคงเหลือแยกหมวด"]).font = { bold: true, size: 14 };
  ws.addRow([entityLabel]);
  ws.addRow([]);
  const head = ws.addRow(["หมวดสินค้า", "สินค้า", "จำนวนคงเหลือ", "ราคาต่อหน่วยเฉลี่ย", "มูลค่ารวม", "คำเตือน"]);
  head.font = { bold: true };
  head.alignment = { vertical: "middle", horizontal: "center" };

  for (const g of report.groups) {
    for (const it of g.items) {
      ws.addRow([g.category, it.productName, it.quantity, it.unitCost, it.value, it.negativeWarning ? "คงเหลือติดลบ" : ""]);
    }
    const t = ws.addRow([`รวม ${g.category}`, "", "", "", g.totalValue, ""]);
    t.font = { bold: true };
  }
  const total = ws.addRow(["รวมทั้งสิ้น", "", "", "", report.grandTotalValue, ""]);
  total.font = { bold: true };

  ws.columns.forEach((c, i) => (c.width = [20, 26, 14, 16, 16, 16][i] ?? 14));
  [3, 4, 5].forEach((col) => (ws.getColumn(col).numFmt = NUMBER_FMT));
}

/**
 * GET /chat-audit/accounting/inventory/export?customerId=<uuid>&productId=<uuid>
 *   Export ทั้ง 2 รายงาน (เฟส 8 ส่วน X, T73): บัตรสต็อกของสินค้าที่เลือก (productId — ไม่บังคับ) +
 *   สินค้าคงเหลือแยกหมวดของลูกค้ารายนี้ทั้งหมด เป็นไฟล์ .xlsx เดียว (คนละชีต)
 *
 * สิทธิ์ (default deny): resolveAccountingAccess + customerInScope (นักบัญชีเห็นเฉพาะลูกค้าตัวเอง)
 * ★ tenantId จาก session (ไม่เชื่อ client) · ไม่ log ชื่อสินค้า/ตัวเลข/ชื่อลูกค้า
 * ★ ใช้ pipeline เดียวกับหน้าจอเป๊ะ (computeStockLedger/buildStockCard/buildInventoryValuationReport) —
 *   ไม่มีสูตรคำนวณคู่ขนาน (mirror budget/export ที่ reuse pipeline เดิมทั้งชุด)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  const rawProductId = url.searchParams.get("productId") ?? "";

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

    const products = await listProducts(service, access.tenantId);

    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name")
      .eq("id", customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    const c = (cust as { customer_code: string | null; name: string | null } | null) ?? null;
    const entityLabel = [c?.customer_code, c?.name].filter(Boolean).join(" · ") || "กิจการ";

    const wb = new ExcelJS.Workbook();

    // ชีต 1 — บัตรสต็อกของสินค้าที่เลือก (ไม่บังคับ — ไม่ระบุ/ไม่พบ → ข้ามชีตนี้)
    const selectedProduct = UUID_RE.test(rawProductId) ? products.find((p) => p.id === rawProductId) : undefined;
    if (selectedProduct) {
      const [opening, movements] = await Promise.all([
        getProductOpeningBalance(service, access.tenantId, customerId, selectedProduct.id),
        listMovements(service, access.tenantId, customerId, selectedProduct.id),
      ]);
      const ledgerRows = computeStockLedger(opening, movements);
      addStockCardSheet(wb, selectedProduct.name, entityLabel, buildStockCard(ledgerRows));
    }

    // ชีต 2 — สินค้าคงเหลือแยกหมวดของลูกค้ารายนี้ทั้งหมด (เฉพาะสินค้าที่มียอดยกมา/รายการเคลื่อนไหวจริง)
    const ledgerInputs: ProductLedgerInput[] = [];
    for (const p of products.slice(0, PRODUCT_LEDGER_LIMIT)) {
      const [opening, movements] = await Promise.all([
        getProductOpeningBalance(service, access.tenantId, customerId, p.id),
        listMovements(service, access.tenantId, customerId, p.id),
      ]);
      if (opening || movements.length > 0) {
        ledgerInputs.push({
          productId: p.id,
          productName: p.name,
          category: p.category,
          ledgerRows: computeStockLedger(opening, movements),
        });
      }
    }
    addValuationSheet(wb, entityLabel, buildInventoryValuationReport(ledgerInputs));

    const xlsx = (await wb.xlsx.writeBuffer()) as unknown as Buffer;

    const codePart = c?.customer_code ? `-${c.customer_code.replace(/[^\w.-]/g, "")}` : `-${customerId.slice(0, 8)}`;
    const filename = `สต็อกสินค้า${codePart}.xlsx`;
    const asciiFallback = `inventory${codePart}.xlsx`;

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
