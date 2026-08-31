import { getFlowAccountSharedConfig } from "@/lib/env";

/**
 * NOVA-CX → FlowAccount OpenAPI — thin REST client (ไม่ vendor SDK — ดู decision 0.1
 * ใน docs/05-flowaccount-integration.md) ยึด pattern `lib/integrations/nova-sales-query.ts`:
 *   - ไม่ตั้ง env ครบ → { ok:false, reason:"not_configured" } ไม่ยิง fetch
 *   - ไม่ throw — ทุก error จับแล้วคืนผลตาม reason
 *   - PDPA: ไม่ log payload เต็ม/เลขภาษี/ยอดเงิน — log แค่ status/reason
 *
 * ★★ M2 — credential ต่อลูกค้า (docs/05-flowaccount-integration.md หมวด M2, decision 0.3/0.4) ★★
 *   `getAccessToken()`/`createSalesDocument()` รับ `FlowAccountCredential` ({clientId, clientSecret})
 *   เป็นพารามิเตอร์ — ไม่อ่าน client_id/secret จาก env เองอีกต่อไป (caller คือ flowaccount-sync.ts
 *   เป็นคนโหลด+ถอดรหัส credential ของลูกค้ารายนั้นแล้วส่งเข้ามา) ส่วน tokenUrl/apiBaseUrl/scope ยังเป็น
 *   env กลาง (`getFlowAccountSharedConfig()`) เหมือนเดิมเพราะไม่ผูกกับบริษัทไหน
 *
 *   ⚠️ token cache เป็น `Map<clientId, {accessToken, expiresAtMs}>` (ไม่ใช่ตัวแปรเดี่ยวเหมือน M1) —
 *   จุดนี้สำคัญที่สุดของ M2: ถ้าพลาดกลับไปใช้ตัวแปรเดี่ยว token ของลูกค้า A จะไปยิงสร้างเอกสารให้ลูกค้า B
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
 *
 * ★★★ เฟส 5 ส่วน P (T30/T31, decision 0.3) — บิลซื้อ/ค่าใช้จ่าย ★★★
 *   ⚠️ endpoint นี้ยังไม่ยืนยันสเปกฉบับเต็มจาก OpenAPI ทางการ (request/response schema ระดับ field) —
 *   เป็นสมมติฐานจากความสมมาตรกับ tax-invoices/cash-invoices ต้องทดสอบกับ sandbox จริงก่อนใช้งานจริง
 *   (T30: ค้นหา `docs/05-flowaccount-integration.md` ทั้งไฟล์แล้วไม่พบสเปก OpenAPI ฉบับเต็มของฝั่งซื้อ/
 *   ค่าใช้จ่ายที่ยืนยันแล้วเหมือนฝั่งขาย — มีแค่ชื่อ class `expensesApi`/`purchaseOrderApi` จาก community SDK
 *   ที่เป็นเอกสารอ้างอิงเท่านั้น ไม่ใช่การยืนยันสเปกจริง)
 *
 *   ★ อัปเดต (ค้นข้อมูลสาธารณะเพิ่ม — ยังไม่ใช่ sandbox test): เอกสารทางการที่ developers.flowaccount.com
 *   ("ภาพรวมใบกำกับภาษีซื้อ (Supplier Invoice)") ยืนยันว่า FlowAccount OpenAPI มีชนิดเอกสาร `expenses` และ
 *   `purchases` อยู่จริง (ใช้ชื่อเดียวกับที่เราเดาไว้ที่นี่) — เพิ่มความมั่นใจว่าชื่อ endpoint ไม่ผิดทาง
 *   แต่ยัง**ไม่ยืนยัน** exact path prefix/request-body field ระดับเดียวกับฝั่งขาย (tax-invoices/cash-invoices
 *   ที่ยืนยันจาก OpenAPI spec เต็มแล้ว) — ยังต้องทดสอบ sandbox จริงก่อนใช้งานจริงอยู่ดี
 *
 *   สมมติฐานที่ใช้ (ตาม decision 0.3 ของแผน docs/06-accounting-features-roadmap.md):
 *     Purchase Bill (เชื่อ ยังไม่จ่าย)  : POST {apiBaseUrl}/purchases  (auth: Bearer token, body=SimpleDocument)
 *     Cash Expense   (จ่ายเงินสดแล้ว)   : POST {apiBaseUrl}/expenses  (body ทรงเดียวกัน)
 *   ทุกจุดที่ยิง fetch จริงรวมไว้ที่ `createPurchaseDocument()`/`purchaseEndpointFor()` — ถ้าสเปกจริงต่างจาก
 *   ที่เดาไว้ (เช่น path อื่น/ทรง response อื่น) แก้ที่ 2 ฟังก์ชันนี้จุดเดียว
 */

export type FlowAccountDocType = "tax_invoice" | "cash_sale";

/** เฟส 5 ส่วน P — ชนิดเอกสารบิลซื้อ/ค่าใช้จ่าย (ดู decision 0.4 ของแผน) */
export type FlowAccountPurchaseDocType = "purchase_bill" | "cash_expense";

/** เหตุผลที่ไม่สำเร็จ — โชว์ UI แบบสุภาพได้โดยไม่หลุด error ดิบ */
export type FlowAccountReason =
  | "not_configured"
  | "auth_failed"
  | "validation_error"
  | "timeout"
  | "network"
  | "server_error";

export type AccessTokenResult = { ok: true; token: string } | { ok: false; reason: FlowAccountReason };

/**
 * credential FlowAccount ของลูกค้ารายหนึ่ง (มาจาก DB ต่อลูกค้า — ไม่ใช่ env กลาง ดู decision 0.3 ของ M2)
 * ประกาศ type นี้ที่นี่ (ไม่ใช่ lib/env.ts) เพราะไม่ได้มาจาก env
 */
export type FlowAccountCredential = {
  clientId: string;
  clientSecret: string;
};

export type SalesDocumentPayload = {
  docType: FlowAccountDocType;
  /** body ที่ mapper (flowaccount-mapper.ts) สร้างมาแล้ว — client ไม่รู้ทรง field ภายใน (ส่งตรง) */
  body: Record<string, unknown>;
};

export type CreateSalesDocumentResult =
  | { ok: true; docId: string; docNo: string | null }
  | { ok: false; reason: FlowAccountReason };

/** เฟส 5 ส่วน P — payload สร้างเอกสารซื้อ/ค่าใช้จ่าย (ทรงเดียวกับ SalesDocumentPayload — ดูคอมเมนต์หัวไฟล์) */
export type PurchaseDocumentPayload = {
  docType: FlowAccountPurchaseDocType;
  /** body ที่ mapper (flowaccount-mapper.ts) สร้างมาแล้ว — client ไม่รู้ทรง field ภายใน (ส่งตรง) */
  body: Record<string, unknown>;
};

export type CreatePurchaseDocumentResult =
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
 *
 * ★ M2: keyed by `clientId` — ห้ามกลับไปเป็นตัวแปรเดี่ยวเด็ดขาด (ดูคอมเมนต์หัวไฟล์) เพราะมีหลายบริษัท
 *   ใช้งานพร้อมกันได้จริงแล้ว แต่ละ clientId ต้องมี token คนละตัวแยกกันชัดเจน
 */
const tokenCache = new Map<string, { accessToken: string; expiresAtMs: number }>();

/** ล้าง cache token ทั้งหมด — ใช้ในเทสต์เท่านั้น (กันเทสต์เคสหนึ่งกระทบเคสถัดไปข้ามกัน) */
export function __resetFlowAccountTokenCacheForTests(): void {
  tokenCache.clear();
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
 * ขอ access token ด้วย OAuth2 client_credentials (cache ตามอายุ token, keyed by credential.clientId)
 *   ไม่ตั้ง env กลางครบ (tokenUrl/apiBaseUrl/scope) → not_configured (ไม่ยิง fetch) แม้ credential ครบ
 */
export async function getAccessToken(credential: FlowAccountCredential): Promise<AccessTokenResult> {
  const config = getFlowAccountSharedConfig();
  if (!config) return { ok: false, reason: "not_configured" };

  const now = Date.now();
  const cached = tokenCache.get(credential.clientId);
  if (cached && cached.expiresAtMs > now) {
    return { ok: true, token: cached.accessToken };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
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
    tokenCache.set(credential.clientId, {
      accessToken,
      expiresAtMs: now + expiresInSec * 1000 - TOKEN_EXPIRY_SAFETY_MS,
    });
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
 *   ไม่ตั้ง env กลางครบ → not_configured (ไม่ยิง fetch) แม้ credential ครบ · ไม่ throw
 *   ★ credential เป็นพารามิเตอร์ (ต่อลูกค้า) — ไม่อ่านจาก env (ดู decision 0.3 ของ M2)
 */
export async function createSalesDocument(
  payload: SalesDocumentPayload,
  credential: FlowAccountCredential
): Promise<CreateSalesDocumentResult> {
  const config = getFlowAccountSharedConfig();
  if (!config) return { ok: false, reason: "not_configured" };

  const tokenResult = await getAccessToken(credential);
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

/**
 * resource path ต่อชนิดเอกสารซื้อ/ค่าใช้จ่าย
 *   ⚠️ ยังไม่ยืนยันสเปกจริงจาก FlowAccount OpenAPI ทางการ (ดูคอมเมนต์หัวไฟล์ + decision 0.3 ของแผน) —
 *   เป็นสมมติฐานจากความสมมาตรกับ `/tax-invoices`/`/cash-invoices` ฝั่งขาย รวมจุดยิง fetch ไว้ที่นี่จุดเดียว
 *   แก้ง่ายถ้าสเปกจริงต่างไป
 */
function purchaseEndpointFor(docType: FlowAccountPurchaseDocType, apiBaseUrl: string): string {
  return docType === "purchase_bill" ? `${apiBaseUrl}/purchases` : `${apiBaseUrl}/expenses`;
}

/**
 * สร้างเอกสารซื้อ/ค่าใช้จ่าย (บิลซื้อเชื่อ/จ่ายเงินสดแล้ว) ที่ FlowAccount — POST + timeout 8s
 *   ⚠️ endpoint ยังไม่ยืนยันสเปก 100% (ดูคอมเมนต์หัวไฟล์ + decision 0.3 ของแผน docs/06) — ต้องทดสอบกับ
 *   sandbox จริงก่อนใช้งานจริง
 *   reuse `getAccessToken`/token cache/timeout/error-mapping เดิมทั้งหมด 100% (ไม่มี logic ใหม่ตรงนี้)
 *   ไม่ตั้ง env กลางครบ → not_configured (ไม่ยิง fetch) แม้ credential ครบ · ไม่ throw
 *   ★ credential เป็นพารามิเตอร์ (ต่อลูกค้า) — ใช้ credential ชุดเดียวกับฝั่งขายของลูกค้ารายนั้น (decision 0.7)
 */
export async function createPurchaseDocument(
  payload: PurchaseDocumentPayload,
  credential: FlowAccountCredential
): Promise<CreatePurchaseDocumentResult> {
  const config = getFlowAccountSharedConfig();
  if (!config) return { ok: false, reason: "not_configured" };

  const tokenResult = await getAccessToken(credential);
  if (!tokenResult.ok) return { ok: false, reason: tokenResult.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
  try {
    const res = await fetch(purchaseEndpointFor(payload.docType, config.apiBaseUrl), {
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
      console.warn(`[flowaccount] create purchase document auth failed status=${res.status}`);
      return { ok: false, reason: "auth_failed" };
    }
    if (res.status >= 400 && res.status < 500) {
      console.warn(`[flowaccount] create purchase document rejected status=${res.status}`);
      return { ok: false, reason: "validation_error" };
    }
    if (!res.ok) {
      console.warn(`[flowaccount] create purchase document failed status=${res.status}`);
      return { ok: false, reason: "server_error" };
    }

    // response ทรงตาม schema SimpleDocumentResponse.data: { recordId, documentSerial, ... } — สมมติฐานเดียวกับ
    // ฝั่งขาย (ยังไม่ยืนยันจริงสำหรับ endpoint นี้ — ดูคอมเมนต์หัวไฟล์)
    const jsonRaw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const data =
      jsonRaw && typeof jsonRaw.data === "object" && jsonRaw.data !== null
        ? (jsonRaw.data as Record<string, unknown>)
        : jsonRaw;
    const docId = pickIdLike(data, ["recordId", "id", "documentId"]);
    if (!docId) {
      console.warn("[flowaccount] create purchase document response missing doc id");
      return { ok: false, reason: "server_error" };
    }
    const docNo = pickIdLike(data, ["documentSerial", "documentNumber", "docNumber"]);
    return { ok: true, docId, docNo };
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    if (name === "AbortError") {
      console.warn("[flowaccount] create purchase document timeout");
      return { ok: false, reason: "timeout" };
    }
    console.warn(`[flowaccount] create purchase document error name=${name}`);
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}
