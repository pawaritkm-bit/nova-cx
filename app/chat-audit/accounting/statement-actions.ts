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
  const timeRaw = typeof r.time === "string" ? r.time.trim() : "";
  return {
    date: s(r.date, 40),
    description: s(r.description, 300),
    counterparty_name: s(r.counterparty_name, 200),
    counterparty_account_no: s(r.counterparty_account_no, 60),
    direction,
    amount,
    time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(timeRaw) ? timeRaw : null,
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

// ---------------------------------------------------------------------
// "ระบบจำไว้" (requirement 2026-09-01): ไฟล์สเตทเมนต์อยู่ใน storage ถาวรอยู่แล้ว
//   - listSavedStatementsAction: ไฟล์ที่เคยอัปของลูกค้า + มีผลอ่านเซฟไว้ไหม (sidecar .txns.json)
//   - loadSavedStatementAction: โหลดผลอ่านที่เซฟไว้ (ไม่ต้องอ่าน/อัปซ้ำ) — ไฟล์เก่าไม่มี sidecar
//     ให้เรียก /api/accounting/extract-statement ด้วย path เดิม (อ่านจาก storage ตรง ๆ ครั้งเดียว)
// ---------------------------------------------------------------------

/** ไฟล์สเตทเมนต์ที่เคยอัปไว้ 1 ไฟล์ */
export type SavedStatementFile = {
  /** path เต็มใน bucket (ใช้โหลด/อ่านซ้ำ) */
  path: string;
  /** ชื่อไฟล์ที่อัป (ตัด timestamp นำหน้าแล้ว) */
  name: string;
  /** โฟลเดอร์เดือนที่อัป (YYYY-MM) */
  month: string;
  /** มีผลอ่านเซฟไว้แล้ว (โหลดได้ทันที ไม่ต้องอ่านใหม่) */
  hasSaved: boolean;
};

/** เพดานเดือนย้อนหลัง + ไฟล์ต่อลูกค้า (กัน listing บาน) */
const SAVED_MONTHS_LIMIT = 12;
const SAVED_FILES_LIMIT = 60;

export async function listSavedStatementsAction(input: {
  customerId: string;
}): Promise<{ ok: true; files: SavedStatementFile[] } | { ok: false; message: string }> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isUuid(input.customerId)) return { ok: false, message: "กรุณาเลือกลูกค้า" };
    if (!customerInScope(ctx, input.customerId)) {
      return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }
    const folderCode = await resolveFolderCode(service, ctx.tenantId, input.customerId);
    if (!folderCode) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    const base = `${ctx.tenantId}/${STATEMENT_PREFIX}/${folderCode}`;

    // ชั้น 1: โฟลเดอร์เดือน (ใหม่→เก่า) · ชั้น 2: ไฟล์ในเดือน
    const { data: monthDirs } = await service.storage.from(BILLS_BUCKET).list(base, { limit: 200 });
    const months = (monthDirs ?? [])
      .map((d) => d.name)
      .filter((n) => /^\d{4}-\d{2}$/.test(n))
      .sort()
      .reverse()
      .slice(0, SAVED_MONTHS_LIMIT);

    const files: SavedStatementFile[] = [];
    for (const m of months) {
      const { data: items } = await service.storage.from(BILLS_BUCKET).list(`${base}/${m}`, { limit: 500 });
      const names = (items ?? []).map((i) => i.name);
      const sidecars = new Set(names.filter((n) => n.endsWith(".txns.json")));
      for (const n of names) {
        if (n.endsWith(".txns.json")) continue;
        files.push({
          path: `${base}/${m}/${n}`,
          name: n.replace(/^[0-9T:.Z-]+_/, ""), // ตัด timestamp นำหน้าที่ server ใส่ตอนอัป
          month: m,
          hasSaved: sidecars.has(`${n}.txns.json`),
        });
        if (files.length >= SAVED_FILES_LIMIT) break;
      }
      if (files.length >= SAVED_FILES_LIMIT) break;
    }
    return { ok: true, files };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "โหลดรายชื่อไฟล์ไม่สำเร็จ กรุณาลองใหม่" };
  }
}

export async function loadSavedStatementAction(input: {
  customerId: string;
  path: string;
}): Promise<{ ok: true; fileName: string; transactions: StatementTxn[] } | { ok: false; message: string }> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);
    if (!isUuid(input.customerId)) return { ok: false, message: "กรุณาเลือกลูกค้า" };
    if (!customerInScope(ctx, input.customerId)) {
      return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }
    const folderCode = await resolveFolderCode(service, ctx.tenantId, input.customerId);
    if (!folderCode) return { ok: false, message: "ไม่พบลูกค้าที่เลือก" };
    // ★ path ต้องอยู่ใต้โฟลเดอร์สเตทเมนต์ของลูกค้ารายนี้เท่านั้น (กันชี้ข้ามลูกค้า/tenant)
    const p = typeof input.path === "string" ? input.path : "";
    if (!p.startsWith(`${ctx.tenantId}/${STATEMENT_PREFIX}/${folderCode}/`) || p.includes("..")) {
      return { ok: false, message: "ไฟล์ไม่ถูกต้อง" };
    }

    const { data: blob, error } = await service.storage
      .from(BILLS_BUCKET)
      .download(p.endsWith(".txns.json") ? p : `${p}.txns.json`);
    if (error || !blob) return { ok: false, message: "ไฟล์นี้ยังไม่มีผลอ่านเซฟไว้ — กด “อ่านอีกครั้ง”" };
    const parsed = JSON.parse(await blob.text()) as {
      fileName?: string;
      transactions?: unknown[];
    };
    const txns = (Array.isArray(parsed.transactions) ? parsed.transactions : [])
      .slice(0, MAX_TXNS_INPUT)
      .map(sanitizeTxn)
      .filter((t): t is StatementTxn => !!t);
    return {
      ok: true,
      fileName: (parsed.fileName || p.split("/").pop() || "ไฟล์").slice(0, 200),
      transactions: txns,
    };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "โหลดผลที่เซฟไว้ไม่สำเร็จ กรุณาลองใหม่" };
  }
}

// ---------------------------------------------------------------------
// กระทบรายการสเตทเมนต์กับบิลในระบบ (สลิป/บิลซื้อ/บิลขาย) — requirement 2026-09-01
//   เงินเข้า ↔ บิลขาย · เงินออก ↔ บิลซื้อ · เทียบยอด (เต็ม/หลังหัก ณ ที่จ่าย) + วัน + ชื่อผู้โอน↔คู่ค้า
// ---------------------------------------------------------------------
import { matchTxnsWithBills, type BillForMatch, type BillMatch } from "@/lib/accounting/statement-bill-match";

export type MatchBillsResult =
  | { ok: true; matches: (BillMatch | null)[]; billCount: number; bills: BillForMatch[] }
  | { ok: false; message: string };

/** เพดานจำนวนบิลที่ดึงมาเทียบ (ลูกค้ารายใหญ่สุดยังห่างจากนี้มาก) */
const MATCH_MAX_BILLS = 2000;

export async function matchStatementWithBillsAction(input: {
  customerId: string;
  txns: unknown[];
}): Promise<MatchBillsResult> {
  try {
    const authed = await createClient();
    const service = createServiceRoleClient();
    const ctx = await requireAccountingAccess(authed, service);

    if (!isUuid(input.customerId)) return { ok: false, message: "กรุณาเลือกลูกค้า" };
    if (!customerInScope(ctx, input.customerId)) {
      return { ok: false, message: "ลูกค้ารายนี้ไม่ได้อยู่ในความดูแลของคุณ" };
    }
    if (!Array.isArray(input.txns)) return { ok: false, message: "ไม่มีรายการให้กระทบ" };
    const txns = input.txns.slice(0, MAX_TXNS_INPUT).map(sanitizeTxn).filter((t): t is StatementTxn => !!t);

    // บิลของลูกค้า (ร่าง+ยืนยัน) — คู่ค้าฝั่งบิล: ขาย=ผู้ซื้อ · ซื้อ=ผู้ขาย · fallback counterparty_name
    const { data: entries } = await service
      .from("bill_entries")
      .select("id, doc_no, doc_date, entry_type, status, counterparty_name, seller_name, buyer_name, upload_path, upload_mime")
      .eq("tenant_id", ctx.tenantId)
      .eq("customer_id", input.customerId)
      .is("deleted_at", null)
      .in("status", ["draft", "confirmed"])
      .order("doc_date", { ascending: false, nullsFirst: false })
      .limit(MATCH_MAX_BILLS);
    const rows = (entries ?? []) as {
      id: string; doc_no: string | null; doc_date: string | null;
      entry_type: "purchase" | "sale" | "unspecified"; status: string;
      counterparty_name: string | null; seller_name: string | null; buyer_name: string | null;
      upload_path: string | null; upload_mime: string | null;
    }[];

    // ★ 2026-09-01 — ลิงก์ดูรูป/ไฟล์บิล (signed URL หมดอายุ 2 ชม. · batch ครั้งเดียว · cap กันช้า)
    const withFile = rows.filter((r) => r.upload_path).slice(0, 400);
    const urlByPath = new Map<string, string>();
    if (withFile.length > 0) {
      try {
        const { data: signed } = await service.storage
          .from(BILLS_BUCKET)
          .createSignedUrls(withFile.map((r) => r.upload_path as string), 7200);
        for (const s of signed ?? []) {
          if (s.signedUrl && s.path) urlByPath.set(s.path, s.signedUrl);
        }
      } catch {
        // เงียบ — ไม่มีรูปก็ยังจับคู่ได้ตามปกติ
      }
    }

    // ยอดต่อบิลจากบรรทัด (chunk กัน URL ยาวเกิน) — gross = amount+vat · net = gross − wht
    const totals = new Map<string, { gross: number; net: number }>();
    for (let i = 0; i < rows.length; i += 150) {
      const ids = rows.slice(i, i + 150).map((r) => r.id);
      const { data: lines } = await service
        .from("bill_entry_lines")
        .select("entry_id, amount, vat_amount, wht_amount")
        .eq("tenant_id", ctx.tenantId)
        .in("entry_id", ids);
      for (const l of (lines ?? []) as { entry_id: string; amount: number | null; vat_amount: number | null; wht_amount: number | null }[]) {
        const t = totals.get(l.entry_id) ?? { gross: 0, net: 0 };
        const gross = (l.amount ?? 0) + (l.vat_amount ?? 0);
        t.gross += gross;
        t.net += gross - (l.wht_amount ?? 0);
        totals.set(l.entry_id, t);
      }
    }

    const bills: BillForMatch[] = rows.map((r) => {
      const t = totals.get(r.id) ?? { gross: 0, net: 0 };
      const counterparty =
        (r.entry_type === "sale" ? r.buyer_name : r.seller_name) || r.counterparty_name || null;
      const uploadUrl = r.upload_path ? urlByPath.get(r.upload_path) ?? null : null;
      return {
        id: r.id,
        docNo: r.doc_no,
        docDate: r.doc_date,
        entryType: r.entry_type,
        status: r.status,
        counterparty,
        totalGross: Math.round(t.gross * 100) / 100,
        totalNet: Math.round(t.net * 100) / 100,
        uploadUrl,
        uploadIsImage: !!uploadUrl && /^image\//i.test(r.upload_mime ?? ""),
      };
    }).filter((b) => b.totalGross > 0 || b.totalNet > 0);

    return { ok: true, matches: matchTxnsWithBills(txns, bills), billCount: bills.length, bills };
  } catch (e) {
    if (e instanceof AccountingAuthError) return { ok: false, message: e.message };
    return { ok: false, message: "กระทบกับบิลไม่สำเร็จ กรุณาลองใหม่" };
  }
}
