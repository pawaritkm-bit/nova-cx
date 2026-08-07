import { getNovaSalesQueryUrl, getNovaSalesQueryApiKey } from "@/lib/env";
import { normalizeTaxId } from "@/lib/accounting/tax-id";

/**
 * NOVA-CX → NOVA Sales (inbound query) — "ดึงข้อมูลลูกค้า" มาเติมในฟอร์มแก้ลูกค้า
 *
 * บริบท:
 *   นักบัญชีอยากเติม ที่อยู่ / เบอร์โทร / ชื่อ ของลูกค้าอัตโนมัติ โดยไม่ต้องพิมพ์เอง —
 *   NOVA Sales (ต้นทางข้อมูลลูกค้า) มี External API v1 (read-only) ให้ query ได้.
 *   เราจับคู่ลูกค้าด้วย "เลขผู้เสียภาษี 13 หลัก" (tax_id ที่ CX มีอยู่).
 *
 * สเปกที่อ้างอิง (NOVA Sales External API v1 — read-only):
 *   - base URL: env NOVA_SALES_QUERY_URL (เช่น https://nova-sales.vercel.app/api/v1)
 *   - auth: header `Authorization: Bearer <key>` — key ฝั่ง NOVA Sales อยู่ใน env NOVA_API_KEYS
 *           (คีย์ของฝั่งบัญชีขึ้นต้น nova_acc_) → CX เก็บใน env NOVA_SALES_QUERY_API_KEY
 *   - endpoint ที่ list ไว้ในเอกสาร: GET /customers, /customers/:id, /customers/:id/monthly, /stats
 *     (read-only, ไม่คืนรหัส DBD/e-Filing)
 *
 * ★★ TODO (ต้องยืนยันกับทีม NOVA Sales ก่อนใช้งานจริง) ★★
 *   เอกสาร External API v1 ยังไม่ระบุชัดว่า GET /customers รองรับ "ค้นด้วยเลขภาษี" ผ่าน query param
 *   ชื่ออะไร (เดาไว้ว่า ?tax_id=<13หลัก>). โค้ดนี้ยิงตามสมมุติฐานนั้น + parse response แบบ
 *   ป้องกันตัว (รองรับได้ทั้ง object เดี่ยว / {data:[...]} / array). ถ้า NOVA Sales ใช้ param อื่น
 *   (เช่น ?taxId= หรือ endpoint แยก /customers/by-tax-id/:taxId) → ปรับ buildQueryUrl() ที่เดียว.
 *   ★ ไม่เดา endpoint ที่ไม่มีในเอกสาร — ยึด /customers ที่ระบุไว้จริง แล้วรอ NOVA Sales ยืนยัน filter.
 *
 * degrade-by-default:
 *   - ไม่ตั้ง URL/KEY → { ok:false, reason:"not_configured" } (ปุ่มแจ้ง "ยังไม่เปิดการเชื่อม")
 *   - ไม่เจอลูกค้า / API ตอบ non-2xx / timeout / network → { ok:false, reason:"not_found"|... }
 *   - ★ ไม่ throw — ทุก error จับแล้วคืนผล ให้ server action เดินต่อได้
 *   - ★ PDPA: ไม่ log เลขภาษี/ชื่อ/ที่อยู่/เบอร์ — log แค่สถานะ/สาเหตุสั้น ๆ
 */

export type NovaSalesCustomerInfo = {
  /** ชื่อลูกค้า (business_name ก่อน แล้ว fallback name) */
  name: string | null;
  /** ที่อยู่บริษัทลูกค้า */
  address: string | null;
  /** เบอร์โทรติดต่อ */
  phone: string | null;
};

export type QueryCustomerResult =
  | { ok: true; data: NovaSalesCustomerInfo }
  | {
      ok: false;
      /** not_configured = ยังไม่ตั้ง env · not_found = ไม่เจอ · invalid_tax_id = เลขภาษีไม่ครบ 13
       *  · unauthorized = key ผิด · error = network/timeout/พลาดอื่น */
      reason: "not_configured" | "invalid_tax_id" | "not_found" | "unauthorized" | "error";
    };

/** timeout กันค้าง (NOVA Sales ช้า/ไม่ตอบ ไม่ให้ค้าง action) */
const QUERY_TIMEOUT_MS = 8000;

/**
 * ต่อ URL ค้นลูกค้าด้วยเลขภาษี (สมมุติฐาน filter = ?tax_id=)
 *   ★ แยกออกมาเป็นฟังก์ชันเดียว เผื่อ NOVA Sales ยืนยัน param/endpoint จริงแล้วแก้ที่เดียว
 */
function buildQueryUrl(baseUrl: string, taxId: string): string {
  return `${baseUrl}/customers?tax_id=${encodeURIComponent(taxId)}`;
}

/** ดึงค่า string ตัวแรกที่ไม่ว่าง จาก candidate keys (parse แบบยืดหยุ่นกับ response หลายทรง) */
function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * แกะ record ลูกค้า 1 รายจาก response ที่รูปแบบไม่แน่นอน:
 *   - array → เอาตัวแรก
 *   - { data: [...] } / { customers: [...] } → เอาตัวแรกใน list
 *   - { data: {...} } → object นั้น
 *   - object เดี่ยว → object นั้น
 */
function extractCustomerRecord(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== "object") return null;
  if (Array.isArray(json)) {
    return (json[0] as Record<string, unknown>) ?? null;
  }
  const o = json as Record<string, unknown>;
  const listCandidate = o.data ?? o.customers ?? o.results;
  if (Array.isArray(listCandidate)) {
    return (listCandidate[0] as Record<string, unknown>) ?? null;
  }
  if (listCandidate && typeof listCandidate === "object") {
    return listCandidate as Record<string, unknown>;
  }
  // object เดี่ยว (ไม่มี wrapper)
  return o;
}

/** map record → {name, address, phone} แบบ best-effort (contact อาจซ้อนใน object contact) */
function mapCustomerInfo(rec: Record<string, unknown>): NovaSalesCustomerInfo {
  const name = pickString(rec, ["business_name", "name", "company_name"]);
  const address = pickString(rec, ["address", "company_address", "billing_address"]);

  // เบอร์โทร: อาจอยู่ระดับบนสุด หรือซ้อนใน contact (ตาม contactSchema ของ inbound)
  let phone = pickString(rec, ["phone", "tel", "mobile", "phone_number"]);
  if (!phone && rec.contact && typeof rec.contact === "object") {
    phone = pickString(rec.contact as Record<string, unknown>, ["phone", "tel", "mobile"]);
  }

  return { name, address, phone };
}

/**
 * ดึงข้อมูลลูกค้าจาก NOVA Sales ด้วยเลขภาษี (best-effort, ไม่ throw)
 *   @param taxId เลขภาษีดิบ (จะ normalize เป็น 13 หลักก่อนยิง)
 */
export async function fetchCustomerFromNovaSales(taxId: string): Promise<QueryCustomerResult> {
  const baseUrl = getNovaSalesQueryUrl();
  const apiKey = getNovaSalesQueryApiKey();

  // ยังไม่เปิดการเชื่อม (ยังไม่ตั้ง env) → แจ้งให้ตั้งค่า ไม่ยิง
  if (!baseUrl || !apiKey) {
    return { ok: false, reason: "not_configured" };
  }

  const norm = normalizeTaxId(typeof taxId === "string" ? taxId : "");
  if (!norm) {
    return { ok: false, reason: "invalid_tax_id" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  try {
    const res = await fetch(buildQueryUrl(baseUrl, norm), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });

    if (res.status === 401 || res.status === 403) {
      console.warn(`[nova-sales-query] auth failed status=${res.status}`);
      return { ok: false, reason: "unauthorized" };
    }
    if (res.status === 404) {
      return { ok: false, reason: "not_found" };
    }
    if (!res.ok) {
      console.warn(`[nova-sales-query] query failed status=${res.status}`);
      return { ok: false, reason: "error" };
    }

    const json = (await res.json().catch(() => null)) as unknown;
    const rec = extractCustomerRecord(json);
    if (!rec) {
      return { ok: false, reason: "not_found" };
    }

    const data = mapCustomerInfo(rec);
    // ไม่มีสักช่องที่ใช้ได้ → ถือว่าไม่เจอข้อมูลที่เอาไปเติมได้
    if (!data.name && !data.address && !data.phone) {
      return { ok: false, reason: "not_found" };
    }
    return { ok: true, data };
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    console.warn(`[nova-sales-query] query error name=${name}`);
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}
