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
