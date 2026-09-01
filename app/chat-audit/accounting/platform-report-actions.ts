"use server";

/**
 * Server actions ของฟีเจอร์ "อ่านรายงานแพลตฟอร์ม" (ข้อ C) — แยกยอดขาย/ค่าธรรมเนียมแพลตฟอร์ม
 *
 * flow ความปลอดภัย/สถาปัตยกรรมเดียวกับ statement-actions.ts ทั้งหมด (ดูคอมเมนต์ที่นั่น) —
 *   ต่างกันแค่ prefix โฟลเดอร์ storage (แยกจากสเตทเมนต์ธนาคาร)
 *
 * ★ ไม่ persist ผล — อัปไฟล์ขึ้น Storage ชั่วคราว, AI อ่าน on-the-fly, คืนผลให้หน้าแสดง
 * ★ PDPA: path ใช้ customer_code (ASCII) ไม่ใช่ชื่อ · ไม่ log ชื่อไฟล์/ลูกค้า/ยอด
 */
import { revalidatePath } from "next/cache";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  customerInScope,
  assertCustomerInScope,
  AccountingAuthError,
} from "@/lib/accounting/access";
import { validateUpload, sanitizeUploadName, extOf } from "@/lib/accounting/upload";
import { listChartOfAccounts } from "@/lib/accounting/chart-accounts-data";
import { buildChartByCode } from "@/lib/accounting/chart-of-accounts";
import {
  getOrCreateDefaultSettings,
  upsertSettings,
  type PlatformReportSettings,
  type PlatformReportSettingsInput,
} from "@/lib/accounting/platform-report-settings";
import { buildPlatformReportJournalEntryInput } from "@/lib/accounting/platform-report-je";
import { upsertManualEntry } from "@/lib/accounting/manual-journal";
import type { PlatformReportSummary } from "@/lib/accounting/platform-report-analyze";

const BILLS_BUCKET = "bills";
/** prefix โฟลเดอร์รายงานแพลตฟอร์ม — route สกัดจะตรวจว่า path ขึ้นต้นด้วย `{tenant}/platform-report/` */
const PLATFORM_REPORT_PREFIX = "platform-report";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** เดือน 'YYYY-MM' (UTC) — โฟลเดอร์เก็บไฟล์ */
function monthFolder(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** timestamp ปลอดภัยกับชื่อไฟล์ (ตัด : และ .) */
function safeStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** sanitize ส่วนของ path เป็น ASCII (กัน key ไทย/`/` → 400 / path traversal) */
function sanitizePathPart(raw: string): string {
  const s = (raw ?? "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/_{2,}/g, "_");
  return s || "unassigned";
}

/** resolve customer_code → ชื่อโฟลเดอร์ (ASCII) · null = ระบุ customerId แต่ไม่พบ */
async function resolveFolderCode(
  service: ReturnType<typeof createServiceRoleClient>,
  tenantId: string,
  customerId: string | null
): Promise<string | null> {
  if (!customerId) return "unassigned";
  const { data: cust } = await service
    .from("customers")
    .select("customer_code")
    .eq("id", customerId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!cust) return null;
  const code = (cust as { customer_code: string | null }).customer_code?.trim();
  return code ? sanitizePathPart(code) : `unassigned-${customerId.slice(0, 8)}`;
}

/**
 * ออก signed upload URL ให้ client อัปไฟล์รายงานแพลตฟอร์มตรงเข้า Storage (กันเพดาน Vercel 4.5MB)
 *   คืน { path, token } — client เอาไป uploadToSignedUrl แล้วเรียก /api/accounting/extract-platform-report
 */
export async function createPlatformReportUploadUrlAction(input: {
  customerId?: string | null;
  fileName: string;
  mime: string;
  size: number;
}): Promise<{ ok: true; path: string; token: string } | { ok: false; message: string }> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    const customerId = isUuid(input.customerId) ? input.customerId : null;
    if (input.customerId != null && input.customerId !== "" && !customerId) {
      return { ok: false, message: "ลูกค้าไม่ถูกต้อง" };
    }
    if (!customerInScope(ctx, customerId)) {
      return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }

    const v = validateUpload({ mime: input.mime, name: input.fileName, size: input.size });
    if (!v.ok) return { ok: false, message: v.error };

    const folderCode = await resolveFolderCode(service, ctx.tenantId, customerId);
    if (folderCode === null) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };

    const safeName = sanitizeUploadName(input.fileName) || `platform-report.${extOf(input.fileName) || "bin"}`;
    const objectPath = [ctx.tenantId, PLATFORM_REPORT_PREFIX, folderCode, monthFolder(), `${safeStamp()}_${safeName}`].join(
      "/"
    );

    const { data, error } = await service.storage.from(BILLS_BUCKET).createSignedUploadUrl(objectPath);
    if (error || !data) return { ok: false, message: "เตรียมอัปโหลดไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, path: data.path, token: data.token };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "เตรียมอัปโหลดไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * โหลดตั้งค่าบัญชี (ผูกประเภทรายงานแพลตฟอร์ม → รหัสบัญชี) ของลูกค้า 1 ราย — สร้างค่าเริ่มต้นให้อัตโนมัติ
 *   ถ้ายังไม่มี (getOrCreateDefaultSettings) — ใช้ตอนสร้างสมุดรายวังดราฟต์ (createPlatformReportDraftJournalEntryAction)
 */
export async function getPlatformReportSettingsAction(
  customerId: string
): Promise<{ ok: true; settings: PlatformReportSettings } | { ok: false; message: string }> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isUuid(customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, customerId);

    const settings = await getOrCreateDefaultSettings(service, ctx.tenantId, customerId);
    return { ok: true, settings };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "โหลดตั้งค่าไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export type SavePlatformReportSettingsInput = PlatformReportSettingsInput & { customerId: string };

/** บันทึกตั้งค่าบัญชี (upsert) — validate ซ้ำฝั่ง server เสมอ (ต้องอยู่ในผังบัญชี + หมวดที่ถูกต้อง) */
export async function savePlatformReportSettingsAction(
  input: SavePlatformReportSettingsInput
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    const res = await upsertSettings(service, ctx.tenantId, input.customerId, input, chartByCode);
    if (!res.ok) return { ok: false, message: res.message };
    return { ok: true, message: "บันทึกตั้งค่าแล้ว" };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "บันทึกตั้งค่าไม่สำเร็จ กรุณาลองใหม่" };
  }
}

/**
 * สร้างสมุดรายวัน (manual JE) แบบดราฟต์จากสรุปรายงานแพลตฟอร์มที่แสดงอยู่บนจอ — ★ ดราฟต์เสมอ ไม่เคย
 *   auto-confirm (ผู้ใช้ยืนยันเองผ่านหน้า "ลงบันทึกบัญชีเอง" ตามปกติ — เหมือน suggestFxGainLossNoteAction)
 *   ต้องตั้งค่าบัญชีให้ครบก่อน (getPlatformReportSettingsAction) — รหัสบัญชีไม่ครบ/ไม่อยู่ในผัง → ปฏิเสธ
 */
export async function createPlatformReportDraftJournalEntryAction(input: {
  customerId: string;
  docDate: string;
  summary: PlatformReportSummary;
}): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isUuid(input.customerId)) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    assertCustomerInScope(ctx, input.customerId);

    const settings = await getOrCreateDefaultSettings(service, ctx.tenantId, input.customerId);
    const built = buildPlatformReportJournalEntryInput(input.summary, settings, input.docDate);
    if (!built.ok) return { ok: false, message: built.message };

    const chart = await listChartOfAccounts(service, ctx.tenantId);
    const chartByCode = buildChartByCode(chart);

    const res = await upsertManualEntry(service, ctx.tenantId, input.customerId, built.value, chartByCode);
    if (!res.ok) return { ok: false, message: res.message };

    revalidatePath("/chat-audit/accounting/journal-entry");
    return { ok: true, id: res.id };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "สร้างสมุดรายวันไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// ---------------------------------------------------------------------
// สร้าง "บิลขาย (ร่าง)" จากยอดขายในรายงานแพลตฟอร์ม (รวมต่อวัน) — requirement 2026-09-01
//   ยอดขาย → บิลขายร่าง → (ยืนยันแล้ว) สมุดรายวัน → แยกประเภท → งบ ไหลด้วย engine เดิม
//   (ค่าธรรมเนียม/รายการหัก ใช้ปุ่ม "สร้างสมุดรายวันดราฟต์" เดิม)
// ---------------------------------------------------------------------
import {
  saleDraftsFromPlatformLines,
  createSaleBillDrafts,
  type CreateSaleBillsResult,
} from "@/lib/accounting/statement-to-bills";
import type { PlatformReportLine } from "@/lib/accounting/platform-report-analyze";

export type CreateBillsFromPlatformResult =
  | ({ ok: true; message: string } & CreateSaleBillsResult)
  | { ok: false; message: string };

const MAX_LINES_INPUT = 20000;

function sanitizePlatformLine(raw: unknown): PlatformReportLine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
  return {
    date: s(r.date, 40),
    order_no: s(r.order_no, 80),
    description: s(r.description, 300),
    category: typeof r.category === "string" ? (r.category as PlatformReportLine["category"]) : null,
    direction: r.direction === "credit" || r.direction === "deduct" ? r.direction : null,
    amount: typeof r.amount === "number" && isFinite(r.amount) ? r.amount : null,
  };
}

export async function createSaleBillsFromPlatformReportAction(input: {
  customerId: string;
  lines: unknown[];
  /** ชื่อแพลตฟอร์ม เช่น Shopee/Lazada (โชว์ในบิล) */
  platformLabel?: string;
}): Promise<CreateBillsFromPlatformResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "กรุณาเลือกลูกค้าก่อนสร้างบิล" };
    assertCustomerInScope(ctx, input.customerId);
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      return { ok: false, message: "ไม่มีรายการให้สร้างบิล" };
    }

    const lines = input.lines
      .slice(0, MAX_LINES_INPUT)
      .map(sanitizePlatformLine)
      .filter((l): l is PlatformReportLine => !!l);
    const label = (typeof input.platformLabel === "string" && input.platformLabel.trim()
      ? input.platformLabel.trim()
      : "แพลตฟอร์ม"
    ).slice(0, 40);
    const drafts = saleDraftsFromPlatformLines(lines, label);
    if (drafts.length === 0) {
      return { ok: false, message: "ไม่มียอดขาย (credit/sales) ที่สร้างบิลได้ — ต้องมีวันที่ + ยอดเงิน" };
    }

    const r = await createSaleBillDrafts(service, {
      tenantId: ctx.tenantId,
      customerId: input.customerId,
      drafts,
      sourceLabel: `รายงานแพลตฟอร์ม ${label}`,
    });

    const dupNote = r.skippedDup > 0 ? ` · ข้าม ${r.skippedDup.toLocaleString("th-TH")} วันที่เคยสร้างแล้ว` : "";
    return {
      ok: true,
      message: `สร้างบิลขาย (ร่าง) ${r.created.toLocaleString("th-TH")} ใบ (รวมยอดขายต่อวัน)${dupNote} — ไปตรวจ/ยืนยันที่โต๊ะทำงานบัญชี`,
      ...r,
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "สร้างบิลไม่สำเร็จ กรุณาลองใหม่" };
  }
}
