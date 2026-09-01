"use server";

/**
 * Server actions ของฟีเจอร์ "AI แยกสเตทเมนต์ ขาเข้า-ขาออก" (Phase 1)
 *
 * flow ความปลอดภัย (ยึดมาตรฐาน write path เดียวกับอัปโหลดบิล):
 *   1) requireAccountingAccess (admin/lead/accountant) + tenantId จาก session (ไม่เชื่อ client)
 *   2) validate ชนิด/ขนาดไฟล์ + สโคปลูกค้า
 *   3) ★ server เป็นเจ้าของ objectPath (client เลือกเองไม่ได้) — อัปได้เฉพาะ path นี้
 *      path อยู่ใต้ `{tenant}/statement/…` (แยกจากบิล manual) → route สกัดตรวจ prefix นี้
 *
 * ★ Phase 1 ไม่ persist ผล — อัปไฟล์ขึ้น Storage ชั่วคราว, AI อ่าน on-the-fly, คืนผลให้หน้าแสดง
 * ★ PDPA: path ใช้ customer_code (ASCII) ไม่ใช่ชื่อ · ไม่ log ชื่อไฟล์/ลูกค้า/ยอด
 */
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  requireAccountingAccess,
  customerInScope,
  AccountingAuthError,
} from "@/lib/accounting/access";
import { validateUpload, sanitizeUploadName, extOf } from "@/lib/accounting/upload";

/** bucket เดียวกับบิล (private) */
const BILLS_BUCKET = "bills";
/** prefix โฟลเดอร์สเตทเมนต์ — route สกัดจะตรวจว่า path ขึ้นต้นด้วย `{tenant}/statement/` */
const STATEMENT_PREFIX = "statement";

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
 * ออก signed upload URL ให้ client อัปไฟล์สเตทเมนต์ตรงเข้า Storage (กันเพดาน Vercel 4.5MB)
 *   คืน { path, token } — client เอาไป uploadToSignedUrl แล้วเรียก /api/accounting/extract-statement
 */
export async function createStatementUploadUrlAction(input: {
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

    const safeName = sanitizeUploadName(input.fileName) || `statement.${extOf(input.fileName) || "bin"}`;
    const objectPath = [ctx.tenantId, STATEMENT_PREFIX, folderCode, monthFolder(), `${safeStamp()}_${safeName}`].join("/");

    const { data, error } = await service.storage.from(BILLS_BUCKET).createSignedUploadUrl(objectPath);
    if (error || !data) return { ok: false, message: "เตรียมอัปโหลดไม่สำเร็จ กรุณาลองใหม่" };
    return { ok: true, path: data.path, token: data.token };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "เตรียมอัปโหลดไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// ---------------------------------------------------------------------
// สร้าง "บิลขาย (ร่าง)" จากรายการเงินเข้าที่อ่านได้ — requirement 2026-09-01
//   เงินเข้า → บิลขายร่าง → (ยืนยันแล้ว) สมุดรายวัน → แยกประเภท → งบ ไหลด้วย engine เดิม
// ---------------------------------------------------------------------
import {
  saleDraftsFromStatementTxns,
  createSaleBillDrafts,
  type CreateSaleBillsResult,
} from "@/lib/accounting/statement-to-bills";
import type { StatementTxn } from "@/lib/accounting/statement-analyze";

export type CreateBillsFromStatementResult =
  | ({ ok: true; message: string } & CreateSaleBillsResult)
  | { ok: false; message: string };

/** เพดานจำนวนรายการที่รับจาก client ต่อครั้ง (กัน payload ผิดปกติ) */
const MAX_TXNS_INPUT = 3000;

/** sanitize txn จาก client ให้เหลือเฉพาะ field ที่ใช้ (ไม่เชื่อโครงจาก client ตรง ๆ) */
function sanitizeTxn(raw: unknown): StatementTxn | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
  const amount = typeof r.amount === "number" && isFinite(r.amount) ? r.amount : null;
  const direction = r.direction === "in" || r.direction === "out" ? r.direction : null;
  return {
    date: s(r.date, 40),
    description: s(r.description, 300),
    counterparty_name: s(r.counterparty_name, 200),
    counterparty_account_no: s(r.counterparty_account_no, 60),
    direction,
    amount,
  };
}

export async function createSaleBillsFromStatementAction(input: {
  customerId: string;
  txns: unknown[];
  /** ป้ายที่มา เช่น ชื่อไฟล์/ธนาคาร (โชว์ใน notes ของบิล) */
  sourceLabel?: string;
}): Promise<CreateBillsFromStatementResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "กรุณาเลือกลูกค้าก่อนสร้างบิล" };
    if (!customerInScope(ctx, input.customerId)) {
      return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }
    if (!Array.isArray(input.txns) || input.txns.length === 0) {
      return { ok: false, message: "ไม่มีรายการให้สร้างบิล" };
    }

    const txns = input.txns.slice(0, MAX_TXNS_INPUT).map(sanitizeTxn).filter((t): t is StatementTxn => !!t);
    const drafts = saleDraftsFromStatementTxns(txns);
    if (drafts.length === 0) return { ok: false, message: "ไม่มีรายการเงินเข้าที่สร้างบิลได้ (ต้องมีวันที่ + ยอดเงิน)" };

    const label = (typeof input.sourceLabel === "string" && input.sourceLabel.trim()
      ? input.sourceLabel.trim()
      : "สเตทเมนต์"
    ).slice(0, 120);
    const r = await createSaleBillDrafts(service, {
      tenantId: ctx.tenantId,
      customerId: input.customerId,
      drafts,
      sourceLabel: label,
    });

    const dupNote = r.skippedDup > 0 ? ` · ข้าม ${r.skippedDup.toLocaleString("th-TH")} รายการที่เคยสร้างแล้ว` : "";
    return {
      ok: true,
      message: `สร้างบิลขาย (ร่าง) ${r.created.toLocaleString("th-TH")} ใบ${dupNote} — ไปตรวจ/ยืนยันที่โต๊ะทำงานบัญชี`,
      ...r,
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "สร้างบิลไม่สำเร็จ กรุณาลองใหม่" };
  }
}
