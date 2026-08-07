import { getFlowAccountConfig } from "@/lib/env";

/**
 * NOVA-CX → FlowAccount OpenAPI — thin REST client (ไม่ vendor SDK — ดู decision 0.1
 * ใน docs/05-flowaccount-integration.md) ยึด pattern `lib/integrations/nova-sales-query.ts`:
 *   - ไม่ตั้ง env ครบ → { ok:false, reason:"not_configured" } ไม่ยิง fetch
 *   - ไม่ throw — ทุก error จับแล้วคืนผลตาม reason
 *   - PDPA: ไม่ log payload เต็ม/เลขภาษี/ยอดเงิน — log แค่ status/reason
 *
 * ★★ T0 — สเปกยืนยันแล้ว 100% จาก OpenAPI spec ทางการของ FlowAccount (developers.flowaccount.com) ★★
 *   Token   : POST {tokenUrl}  body=application/x-www-form-urlencoded
 *             { client_id, client_secret, grant_type=client_credentials, scope }
 *             response (schema AuthenResponse): { access_token, expires_in, token_type, refresh_token, error }
 *   Tax Invoice (เชื่อ/ยังไม่รับเงิน) : POST {apiBaseUrl}/tax-invoices  (auth: Bearer token, body=SimpleDocument)
 *   Cash Sale   (รับเงินแล้ว)        : POST {apiBaseUrl}/cash-invoices (body ทรงเดียวกัน — CASimpleDocument)
 *   Response ตอนสร้างสำเร็จ (schema SimpleDocumentResponse → data): `recordId` (int64, id เอกสาร) +
 *     `documentSerial` (string, เลขที่เอกสาร) — ยืนยันจาก schema จริง ไม่ใช่การเดาแล้ว
 *
 *   หมายเหตุ: /cash-invoices แบบนี้ (ไม่มี payment) ยังไม่ทำให้เอกสารเป็นสถานะ "เก็บเงินแล้ว" — สร้างแล้วอยู่
 *   สถานะ "รอดำเนินการ" เหมือนกันทั้งคู่ ต่างกันที่ "ชนิดเอกสาร" เท่านั้น (M1 ตั้งใจไม่ส่งข้อมูลการชำระเงิน —
 *   ต้อง /tax-invoices/with-payment หรือ /cash-invoices/with-payment ถึงจะมาร์คเก็บเงินแล้ว ซึ่งต้องมี
 *   bankAccountId ฝั่ง FlowAccount ที่เรายังไม่มี mapping — เกินขอบเขต M1 ตามเจตนาเดิมของแผน)
 */

export type FlowAccountDocType = "tax_invoice" | "cash_sale";

/** เหตุผลที่ไม่สำเร็จ — โชว์ UI แบบสุภาพได้โดยไม่หลุด error ดิบ */
export type FlowAccountReason =
  | "not_configured"
  | "auth_failed"
  | "validation_error"
  | "timeout"
  | "network"
  | "server_error";

export type AccessTokenResult = { ok: true; token: string } | { ok: false; reason: FlowAccountReason };

export type SalesDocumentPayload = {
  docType: FlowAccountDocType;
  /** body ที่ mapper (flowaccount-mapper.ts) สร้างมาแล้ว — client ไม่รู้ทรง field ภายใน (ส่งตรง) */
  body: Record<string, unknown>;
};

export type CreateSalesDocumentResult =
  | { ok: true; docId: string; docNo: string | null }
  | { ok: false; reason: FlowAccountReason };

/** timeout กันค้าง — FlowAccount ช้า/ไม่ตอบ ไม่ให้ปุ่มค้าง */
const TOKEN_TIMEOUT_MS = 8000;
const CREATE_TIMEOUT_MS = 8000;

/** เผื่อ clock skew/เวลาที่ใช้ยิง request จริง — ถือว่า token หมดอายุก่อนเวลาจริง 60 วิ */
const TOKEN_EXPIRY_SAFETY_MS = 60_000;

/**
 * cache token ใน memory ของ process (Vercel/Node server ทำงานแบบ long-lived ต่อ instance)
 * กันขอ token ใหม่ทุกครั้งที่กดส่งบิล (ประหยัด round-trip + กัน rate limit ฝั่ง FlowAccount)
 */
let cachedToken: { accessToken: string; expiresAtMs: number } | null = null;

/** ล้าง cache token — ใช้ในเทสต์เท่านั้น (กันเทสต์เคสหนึ่งกระทบเคสถัดไปข้ามกัน) */
export function __resetFlowAccountTokenCacheForTests(): void {
  cachedToken = null;
}

/** ดึง string ตัวแรกจาก candidate keys ที่เป็น string ไม่ว่าง หรือ number → แปลงเป็น string */
function pickIdLike(json: Record<string, unknown> | null, keys: string[]): string | null {
  if (!json) return null;
  for (const k of keys) {
    const v = json[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * ขอ access token ด้วย OAuth2 client_credentials (cache ตามอายุ token)
 *   ไม่ตั้ง env ครบ → not_configured (ไม่ยิง fetch)
 */
export async function getAccessToken(): Promise<AccessTokenResult> {
  const config = getFlowAccountConfig();
  if (!config) return { ok: false, reason: "not_configured" };

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs > now) {
    return { ok: true, token: cachedToken.accessToken };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "client_credentials",
      scope: config.scope,
    });
    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
      cache: "no-store",
    });

    if (res.status === 401 || res.status === 403) {
      console.warn(`[flowaccount] token auth failed status=${res.status}`);
      return { ok: false, reason: "auth_failed" };
    }
    if (res.status >= 400 && res.status < 500) {
      console.warn(`[flowaccount] token request rejected status=${res.status}`);
      return { ok: false, reason: "validation_error" };
    }
    if (!res.ok) {
      console.warn(`[flowaccount] token request failed status=${res.status}`);
      return { ok: false, reason: "server_error" };
    }

    const json = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number }
      | null;
    const accessToken = json?.access_token;
    if (!accessToken) {
      console.warn("[flowaccount] token response missing access_token");
      return { ok: false, reason: "server_error" };
    }
    const expiresInSec =
      typeof json?.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
    cachedToken = {
      accessToken,
      expiresAtMs: now + expiresInSec * 1000 - TOKEN_EXPIRY_SAFETY_MS,
    };
    return { ok: true, token: accessToken };
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    if (name === "AbortError") {
      console.warn("[flowaccount] token request timeout");
      return { ok: false, reason: "timeout" };
    }
    console.warn(`[flowaccount] token request error name=${name}`);
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** resource path ต่อชนิดเอกสาร (ยืนยันจาก Postman — ดูคอมเมนต์หัวไฟล์) */
function endpointFor(docType: FlowAccountDocType, apiBaseUrl: string): string {
  return docType === "tax_invoice" ? `${apiBaseUrl}/tax-invoices` : `${apiBaseUrl}/cash-invoices`;
}

/**
 * สร้างเอกสารขาย (ใบกำกับภาษี/ใบเสร็จรับเงิน) ที่ FlowAccount — POST + timeout 8s
 *   ไม่ตั้ง env ครบ → not_configured (ไม่ยิง fetch) · ไม่ throw
 */
export async function createSalesDocument(
  payload: SalesDocumentPayload
): Promise<CreateSalesDocumentResult> {
  const config = getFlowAccountConfig();
  if (!config) return { ok: false, reason: "not_configured" };

  const tokenResult = await getAccessToken();
  if (!tokenResult.ok) return { ok: false, reason: tokenResult.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
  try {
    const res = await fetch(endpointFor(payload.docType, config.apiBaseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenResult.token}`,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload.body),
      signal: controller.signal,
      cache: "no-store",
    });

    if (res.status === 401 || res.status === 403) {
      console.warn(`[flowaccount] create document auth failed status=${res.status}`);
      return { ok: false, reason: "auth_failed" };
    }
    if (res.status >= 400 && res.status < 500) {
      console.warn(`[flowaccount] create document rejected status=${res.status}`);
      return { ok: false, reason: "validation_error" };
    }
    if (!res.ok) {
      console.warn(`[flowaccount] create document failed status=${res.status}`);
      return { ok: false, reason: "server_error" };
    }

    // response ทรงตาม schema SimpleDocumentResponse.data: { recordId, documentSerial, ... }
    // top-level เผื่อบาง endpoint ห่อ data ต่างกัน (ยืนยันจาก OpenAPI spec — ไม่ใช่การเดา)
    const jsonRaw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const data =
      jsonRaw && typeof jsonRaw.data === "object" && jsonRaw.data !== null
        ? (jsonRaw.data as Record<string, unknown>)
        : jsonRaw;
    const docId = pickIdLike(data, ["recordId", "id", "documentId"]);
    if (!docId) {
      console.warn("[flowaccount] create document response missing doc id");
      return { ok: false, reason: "server_error" };
    }
    const docNo = pickIdLike(data, ["documentSerial", "documentNumber", "docNumber"]);
    return { ok: true, docId, docNo };
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    if (name === "AbortError") {
      console.warn("[flowaccount] create document timeout");
      return { ok: false, reason: "timeout" };
    }
    console.warn(`[flowaccount] create document error name=${name}`);
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}
