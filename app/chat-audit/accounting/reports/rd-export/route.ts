import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/env";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveAccountingAccess, customerInScope } from "@/lib/accounting/access";
import { listEntries } from "@/lib/accounting/queries";
import { filterEntriesForReport, periodLabel, validMonth } from "@/lib/accounting/report-filter";
import {
  buildPndReport,
  buildPndTextLines,
  buildPndWorkbook,
  buildPp30Report,
  buildPp30TextLines,
  buildPp30Workbook,
  encodeRdText,
  joinRdLines,
  resolveTxtEncoding,
  type PndForm,
  type Pp30Kind,
} from "@/lib/accounting/rd-export";

export const dynamic = "force-dynamic";

const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RdForm = "pnd3" | "pnd53" | "pp30-sale" | "pp30-purchase";
const FORMS: RdForm[] = ["pnd3", "pnd53", "pp30-sale", "pp30-purchase"];
/** ป้ายชื่อไฟล์แบบ ASCII (ไม่ใช้ชื่อ/PII) */
const FORM_SLUG: Record<RdForm, string> = {
  pnd3: "pnd3",
  pnd53: "pnd53",
  "pp30-sale": "pp30-sale",
  "pp30-purchase": "pp30-purchase",
};

/**
 * GET /chat-audit/accounting/reports/rd-export
 *   ?customerId=<uuid>&from=YYYY-MM&to=YYYY-MM&draft=0&form=pnd3|pnd53|pp30-sale|pp30-purchase&fmt=txt|xlsx
 *   ออกไฟล์ยื่นกรมสรรพากร (RD Prep): ภ.ง.ด.3/53 (WHT) หรือ ภ.พ.30 ภาษีขาย/ซื้อ — ทั้ง .txt และ Excel
 *
 * สิทธิ์ (default deny): resolveAccountingAccess + customerInScope · tenantId จาก session
 * ★ ชื่อไฟล์ใช้รหัสลูกค้า+งวด+แบบ (ASCII) ไม่ใส่ชื่อ/PII · ไม่ log เนื้อบิล
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  const from = validMonth(url.searchParams.get("from"));
  const to = validMonth(url.searchParams.get("to"));
  const includeDraft = url.searchParams.get("draft") !== "0";
  const form = url.searchParams.get("form") as RdForm | null;
  const fmt = url.searchParams.get("fmt") === "xlsx" ? "xlsx" : "txt";

  if (!getSupabaseEnv()) {
    return NextResponse.json({ error: "db_unavailable", message: "ยังไม่ได้ตั้งค่าฐานข้อมูล" }, { status: 503 });
  }
  if (!UUID_RE.test(customerId)) {
    return NextResponse.json({ error: "invalid_params", message: "ต้องระบุลูกค้า" }, { status: 400 });
  }
  if (!form || !FORMS.includes(form)) {
    return NextResponse.json({ error: "invalid_params", message: "ระบุแบบไม่ถูกต้อง" }, { status: 400 });
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

    const { entries } = await listEntries(service, access.tenantId, { customerId });
    const filtered = filterEntriesForReport(entries, { from, to, includeDraft });

    // ป้ายกิจการ (รหัส+ชื่อ) สำหรับหัว Excel + รหัสลูกค้าไว้ตั้งชื่อไฟล์ (ASCII)
    const { data: cust } = await service
      .from("customers")
      .select("customer_code, name, tax_id")
      .eq("id", customerId)
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    const c =
      (cust as { customer_code: string | null; name: string | null; tax_id: string | null } | null) ??
      null;
    const entityLabel = [c?.customer_code, c?.name].filter(Boolean).join(" · ") || "กิจการ";
    const pLabel = periodLabel(from, to);
    // payerTaxId = เลขภาษีของลูกค้าเรา (ผู้มีหน้าที่หักภาษี ณ ที่จ่าย) — โชว์บนหัวใบแนบ
    const header = { entityLabel, periodLabel: pLabel, payerTaxId: c?.tax_id ?? null };

    // ---- สร้างไฟล์ตามแบบ + รูปแบบ ----
    let body: Buffer;
    let contentType: string;
    let ext: string;

    if (form === "pnd3" || form === "pnd53") {
      const report = buildPndReport(filtered, form as PndForm);
      if (fmt === "xlsx") {
        body = await buildPndWorkbook(report, header);
        contentType = XLSX_CONTENT_TYPE;
        ext = "xlsx";
      } else {
        const text = joinRdLines(buildPndTextLines(report));
        body = encodeRdText(text);
        contentType = `text/plain; charset=${resolveTxtEncoding()}`;
        ext = "txt";
      }
    } else {
      const kind: Pp30Kind = form === "pp30-sale" ? "sale" : "purchase";
      const report = buildPp30Report(filtered, kind);
      if (fmt === "xlsx") {
        body = await buildPp30Workbook(report, header);
        contentType = XLSX_CONTENT_TYPE;
        ext = "xlsx";
      } else {
        const text = joinRdLines(buildPp30TextLines(report));
        body = encodeRdText(text);
        contentType = `text/plain; charset=${resolveTxtEncoding()}`;
        ext = "txt";
      }
    }

    const codePart = c?.customer_code
      ? c.customer_code.replace(/[^\w.-]/g, "")
      : customerId.slice(0, 8);
    const periodPart = from || to ? `_${from || "start"}-${to || "latest"}` : "";
    const filename = `rd_${FORM_SLUG[form]}_${codePart}${periodPart}.${ext}`;

    return new NextResponse(body as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "server_error", message: "ออกไฟล์ยื่นสรรพากรไม่สำเร็จ" }, { status: 500 });
  }
}
