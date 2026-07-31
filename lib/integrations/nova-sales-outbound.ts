import { getNovaSalesApiKey, getNovaSalesOutboundUrl } from "@/lib/env";
import { AUTH_HEADER } from "@/lib/integrations/nova-sales";

/**
 * NOVA-CX → NOVA Sale (outbound) — ส่งเลขภาษีลูกค้ากลับให้ NOVA Sale เก็บ
 *
 * บริบท (loop เก็บเลขภาษี):
 *   บิลหลายใบไม่มีเลขภาษีให้ AI อ่าน → จับซื้อ/ขายไม่ได้.
 *   นักบัญชีกรอกเลขภาษีที่ขาดในหน้า /chat-audit/accounting → CX จำไว้ที่ customers.tax_id
 *   แล้วส่งกลับ NOVA Sale (ต้นทางข้อมูลลูกค้า) ให้เก็บด้วย เพื่อครั้งหน้ามีเลขภาษีมาแต่ต้น.
 *
 * หลักการ (degrade-by-default):
 *   ★ ยังไม่ตั้ง NOVA_SALES_OUTBOUND_URL → skip (คืน {ok:true, skipped:true}) log 'pending' ไม่ error
 *     (NOVA Sale ยังไม่เปิด endpoint = ไม่พังฝั่ง CX)
 *   ★ ตั้งแล้ว → POST { external_customer_id, customer_code, tax_id } + auth header (x-api-key)
 *     ตาม pattern integration เดิม (checkNovaSalesAuth ใช้ header เดียวกัน)
 *   ★ ไม่ throw — ทุก error จับแล้วคืน {ok:false, error} ให้ผู้เรียก (server action) เดินต่อได้
 *   ★ PDPA: ไม่ log tax_id/ชื่อลูกค้า/ตัวชี้ตัวตน — log แค่สถานะสั้น ๆ
 */

export type PushTaxIdArgs = {
  /** external_ref ของลูกค้าใน CX = id ลูกค้าฝั่ง NOVA Sale (ตัวชี้เป้าหลัก) */
  externalRef: string | null;
  /** รหัสลูกค้า (customer_code) — ตัวชี้เป้าสำรอง */
  customerCode: string | null;
  /** เลขภาษี 13 หลัก (strip แล้ว) ที่นักบัญชีกรอก */
  taxId: string;
};

export type PushTaxIdResult = {
  ok: boolean;
  /** true = ข้าม (ยังไม่เปิด outbound / ไม่มีตัวชี้เป้า) — ไม่ถือว่าล้มเหลว */
  skipped?: boolean;
  /** เหตุผลสั้น ๆ (ไม่มี PII) เมื่อ ok=false */
  error?: string;
};

/** timeout กันค้าง (NOVA Sale ช้า/ไม่ตอบ ไม่ให้ค้าง action) */
const OUTBOUND_TIMEOUT_MS = 8000;

/**
 * ส่งเลขภาษีลูกค้ากลับ NOVA Sale (best-effort)
 *   - ไม่ตั้ง URL → skip
 *   - ไม่มีทั้ง external_ref และ customer_code → skip (NOVA Sale จับคู่ลูกค้าไม่ได้)
 *   - ยิง POST พร้อม x-api-key; non-2xx / เชื่อมต่อพลาด / timeout → {ok:false} (ไม่ throw)
 */
export async function pushCustomerTaxId(
  args: PushTaxIdArgs
): Promise<PushTaxIdResult> {
  const url = getNovaSalesOutboundUrl();
  if (!url) {
    // ยังไม่เปิด endpoint ฝั่ง NOVA Sale — คงเลขภาษีไว้ที่ CX ไปก่อน (ไม่พัง)
    console.info("[nova-sales-outbound] pending — NOVA_SALES_OUTBOUND_URL not set, skip push");
    return { ok: true, skipped: true };
  }

  // ต้องมีตัวชี้เป้าอย่างน้อย 1 อย่าง ไม่งั้น NOVA Sale ไม่รู้ว่าลูกค้ารายไหน
  if (!args.externalRef && !args.customerCode) {
    console.info("[nova-sales-outbound] skip — no external_ref/customer_code to identify customer");
    return { ok: true, skipped: true };
  }

  const apiKey = getNovaSalesApiKey();
  const headers: Record<string, string> = { "content-type": "application/json" };
  // auth ตาม pattern integration เดิม (x-api-key) — ไม่มี key ก็ยังยิง (ให้ NOVA Sale ตัดสินใจ)
  if (apiKey) headers[AUTH_HEADER] = apiKey;

  const body = JSON.stringify({
    external_customer_id: args.externalRef,
    customer_code: args.customerCode,
    tax_id: args.taxId,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[nova-sales-outbound] push failed status=${res.status}`);
      return { ok: false, error: `status_${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    console.warn(`[nova-sales-outbound] push error name=${name}`);
    return { ok: false, error: name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
