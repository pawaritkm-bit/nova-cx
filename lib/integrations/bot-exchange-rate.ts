/**
 * ดึงอัตราแลกเปลี่ยนอ้างอิงรายวันของธนาคารแห่งประเทศไทย (ธปท.) — best-effort prefill เท่านั้น (เฟส 10, 0.12)
 *
 * ★★ ความเสี่ยงที่ทราบอยู่แล้ว (ดู docs/06-accounting-features-roadmap.md เฟส 10 หมวด 5) ★★
 *   endpoint จริง/รูปแบบข้อมูลของ ธปท. ยังไม่ยืนยัน 100% ก่อนเขียนโค้ด (ต่างจาก FlowAccount ที่มี OpenAPI
 *   ทางการ) — รวมจุดยิง fetch ไว้ที่ `fetchBotReferenceRate()` จุดเดียวในไฟล์นี้ (แก้ที่เดียวถ้า endpoint
 *   จริงเปลี่ยน/ต่างจากที่เดาไว้) ★ ฟีเจอร์หลักของเฟส 10 (บันทึกบิล FX/รับ-จ่ายเงิน/CN-DN) ไม่พึ่งไฟล์นี้เลย —
 *   ใช้งานได้ปกติแม้ endpoint นี้ผิด/ล่ม (นักบัญชีกรอกอัตราเองได้เสมอ)
 *
 * ★ best-effort เท่านั้น — prefill ช่อง fx_rate ที่ UI · นักบัญชีแก้ทับได้เสมอ (manual override ชนะเสมอ)
 * ★ try/catch ครอบทุกกรณี (network/timeout/status ไม่ 200/format เปลี่ยน/ไม่มีอัตราของสกุลนั้นวันนั้น) —
 *   ไม่ throw ทะลุออกไปเด็ดขาด, ไม่ block การบันทึกบิล
 * ★ PDPA: ไม่ log response payload เต็ม (แค่ code/สถานะสั้น ๆ)
 */

const TIMEOUT_MS = 8000;

/** endpoint สาธารณะของ ธปท. (Bank of Thailand Data Services) — ดูคอมเมนต์หัวไฟล์ ถ้าเปลี่ยนแก้ที่นี่จุดเดียว */
const BOT_ENDPOINT = "https://apigw1.bot.or.th/bot/public/Stat-ExchangeRate/v2/DAILY_AVG_EXG_RATE/";

export type BotRateResult = { ok: true; rate: number } | { ok: false };

type BotApiRow = {
  period?: string;
  currency_id?: string;
  currency?: string;
  mid_rate?: number | string;
  rate?: number | string;
};

type BotApiResponse = {
  result?: {
    data?: {
      data_detail?: BotApiRow[];
    };
  };
};

/** วันที่ YYYY-MM-DD → true ถ้ารูปแบบถูกต้อง (เดือน 01-12, วัน 01-31 — เหมือน DATE_RE ที่อื่นในระบบ) */
function isValidDate(v: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v);
}

/**
 * ดึงอัตราแลกเปลี่ยนอ้างอิงรายวัน ธปท. ของสกุลเงิน+วันที่ที่ระบุ (best-effort, 0.12)
 *   @param currency ISO 4217 code (เช่น "USD") — ต้องผ่าน isValidCurrencyCode ก่อนเรียก (caller รับผิดชอบ)
 *   @param date วันที่ YYYY-MM-DD
 *   @returns {ok:true, rate} เมื่อดึงสำเร็จและมีอัตราของสกุลนั้นวันนั้น · {ok:false} ทุกกรณีที่ล้มเหลว
 *     (ไม่ throw ไม่ว่ากรณีใด)
 */
export async function fetchBotReferenceRate(currency: string, date: string): Promise<BotRateResult> {
  if (!/^[A-Z]{3}$/.test(currency) || !isValidDate(date)) return { ok: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${BOT_ENDPOINT}?start_period=${date}&end_period=${date}&currency=${currency}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`[bot-exchange-rate] request failed status=${res.status}`);
      return { ok: false };
    }

    const json = (await res.json().catch(() => null)) as BotApiResponse | null;
    const rows = json?.result?.data?.data_detail;
    if (!Array.isArray(rows) || rows.length === 0) return { ok: false };

    const row = rows.find((r) => (r.currency_id ?? r.currency) === currency) ?? rows[0];
    const raw = row?.mid_rate ?? row?.rate;
    const rate = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(rate) || rate <= 0) return { ok: false };

    return { ok: true, rate };
  } catch {
    // network error / timeout / รูปแบบเปลี่ยนกะทันหัน — degrade เงียบ (0.12)
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
