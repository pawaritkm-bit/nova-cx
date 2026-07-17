/**
 * helper ฝั่ง LIFF endpoint (base page /liff/survey)
 * pure function (ไม่พึ่ง env/network) → unit test ได้
 *
 * บริบท: LINE เปิด LIFF endpoint URL (/liff/survey) ก่อนเสมอ แล้วส่ง extra path
 * มาทาง query `liff.state` (เช่น ?liff.state=%2F{token}) ให้ liff.init() redirect เอง
 * หน้า base จึงต้องดึง token ออกจากได้ทั้ง ?token= และ liff.state
 */

/** ค่าจาก searchParams อาจเป็น string เดี่ยวหรือ array → เอาค่าแรก */
export function firstQueryValue(
  v: string | string[] | undefined
): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * ดึง token แบบประเมินจาก query ของหน้า base /liff/survey
 *  - `token`     : query ?token={token} ตรง ๆ (รูปแบบใหม่ที่ buildLiffSurveyUrl ใช้)
 *  - `liffState` : query liff.state ที่ LINE แนบ extra path มา
 *                  ค่าอาจเป็น "/{token}", "%2F{token}" (encoded) หรือ "{token}" เฉย ๆ
 * คืน token ที่สะอาด หรือ null ถ้าหาไม่เจอ
 */
export function extractLiffToken(params: {
  token?: string;
  liffState?: string;
}): string | null {
  // 1) ?token= มาก่อน (ตรงและชัดที่สุด)
  const direct = params.token?.trim();
  if (direct) return direct;

  // 2) liff.state — ถอด token ออก
  let state = params.liffState?.trim();
  if (!state) return null;

  // Next.js ถอด url-encode ให้แล้วระดับหนึ่ง แต่เผื่อกรณี "%2F..." ยังหลุดมา
  // ลอง decode อีกชั้นแบบ best-effort (token เป็น base64url จึงไม่มี %/ อยู่แล้ว)
  try {
    state = decodeURIComponent(state);
  } catch {
    // decode ไม่ได้ → ใช้ค่าดิบต่อ
  }

  state = state.replace(/^\/+/, ""); // ตัด "/" นำหน้า (เช่น "/{token}")
  state = state.split(/[?#]/)[0]; // เผื่อ liff.state พก query/hash ต่อท้าย เอาเฉพาะ path

  return state ? state : null;
}

// ==========================================================================
// กัน token หลุดจาก OAuth redirect (บั๊ก "ไม่พบลิงก์แบบประเมิน")
// ==========================================================================

/**
 * sessionStorage key สำหรับกู้ token กรณี edge ที่หน้าหลุด ?token= หลังกลับจาก OAuth
 * (เป้าหลักคือ "ไม่ให้เกิด OAuth redirect" ตั้งแต่แรก — key นี้เป็น safety net ชั้นสอง)
 */
export const LIFF_TOKEN_STORAGE_KEY = "nova-cx:liff-token";

/**
 * true = URL บ่งชี้ว่าเพิ่งกลับจาก LINE OAuth (LINE Login) — สังเกตจาก query
 * `code` / `state` / `liffRedirectUri` ที่ LINE แนบกลับมาหลัง login
 * ใช้ตัดสินใจว่าควรลองกู้ token จาก sessionStorage หรือไม่
 */
export function hasOAuthReturnParams(params: {
  code?: string | null;
  state?: string | null;
  liffRedirectUri?: string | null;
}): boolean {
  return Boolean(params.code || params.state || params.liffRedirectUri);
}

/**
 * กู้/เลือก token แบบประเมินให้ทนทาน:
 *   1) มี token ตรง ๆ (จาก props/URL) → ใช้เลย
 *   2) ไม่มี token แต่ "เพิ่งกลับจาก OAuth" (isOAuthReturn) → กู้จาก storedToken
 *   3) นอกนั้น → null (ให้ฝั่ง client โชว์ "ไม่พบ")
 * เหตุที่กู้เฉพาะตอน OAuth return: กัน token เก่าค้าง storage มาปนกับการเปิดหน้าเปล่า ๆ
 */
export function resolveSurveyToken(args: {
  initialToken?: string | null;
  storedToken?: string | null;
  isOAuthReturn: boolean;
}): string | null {
  const initial = args.initialToken?.trim();
  if (initial) return initial;
  if (args.isOAuthReturn) {
    const stored = args.storedToken?.trim();
    if (stored) return stored;
  }
  return null;
}

/**
 * liff client ที่ init แล้ว (subset ที่เราใช้จริง)
 * ⚠️ ไม่มี `login` โดยเจตนา — แบบประเมินยืนยันสิทธิ์ด้วย token ห้าม redirect ไป LINE Login
 */
export type LiffClient = {
  init: (config: { liffId: string }) => Promise<void>;
  isLoggedIn: () => boolean;
  getProfile: () => Promise<{ userId: string }>;
};

/**
 * ดึง LINE userId แบบ best-effort จาก liff ที่ init แล้ว
 *   - ยังไม่ล็อกอิน → คืน null ทันที (ไม่เรียก login/redirect เด็ดขาด)
 *   - ล็อกอินแล้ว → คืน userId จาก profile
 *   - error ใด ๆ → null (ไม่ crash — ตอบผ่าน token ได้อยู่)
 */
export async function getBestEffortLineUserId(
  liff: LiffClient
): Promise<string | null> {
  try {
    if (!liff.isLoggedIn()) return null;
    const profile = await liff.getProfile();
    return profile.userId ?? null;
  } catch {
    return null;
  }
}
