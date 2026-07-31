/**
 * LINE Login (OAuth 2.0 / OIDC) — flow แบบเว็บ (ไม่ใช่ LIFF)
 *   authorize (redirect) → callback (code) → exchange code เอา id_token → verify → userId
 *
 * เอกสาร:
 *   authorize: GET  https://access.line.me/oauth2/v2.1/authorize
 *   token:     POST https://api.line.me/oauth2/v2.1/token
 *
 * ★ ต้องขอ scope 'openid' ถึงจะได้ id_token (JWT) กลับมา — เราใช้ id_token verify หา userId
 * ★ state (CSRF): ผูกกับ browser ผ่าน cookie + signed token (ดู route login/callback)
 */

export const LINE_AUTHORIZE_URL = "https://access.line.me/oauth2/v2.1/authorize";
export const LINE_TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";

/** ประกอบ URL สำหรับ redirect ผู้ใช้ไปหน้า authorize ของ LINE */
export function buildLineAuthorizeUrl(p: {
  channelId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  scope?: string;
}): string {
  const sp = new URLSearchParams({
    response_type: "code",
    client_id: p.channelId,
    redirect_uri: p.redirectUri,
    state: p.state,
    scope: p.scope ?? "openid profile",
    nonce: p.nonce,
  });
  return `${LINE_AUTHORIZE_URL}?${sp.toString()}`;
}

/** fetch แบบฉีดได้ (test mock) */
type FetchLike = typeof fetch;

/**
 * แลก authorization code → id_token (JWT)
 *   คืน null ทุกความล้มเหลว (พารามิเตอร์ขาด/HTTP ไม่ ok/ไม่มี id_token/network error) — fail-closed
 *   ★ ไม่ log code/secret/token
 */
export async function exchangeLineCodeForIdToken(
  p: {
    code: string;
    redirectUri: string;
    channelId: string;
    channelSecret: string;
  },
  fetchImpl: FetchLike = fetch
): Promise<{ idToken: string } | null> {
  if (!p.code || !p.redirectUri || !p.channelId || !p.channelSecret) return null;
  try {
    const res = await fetchImpl(LINE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: p.code,
        redirect_uri: p.redirectUri,
        client_id: p.channelId,
        client_secret: p.channelSecret,
      }).toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id_token?: unknown };
    const idToken = typeof data.id_token === "string" ? data.id_token.trim() : "";
    if (!idToken) return null;
    return { idToken };
  } catch {
    return null;
  }
}

/** payload ของ OAuth state (signed) — เก็บปลายทางหลัง login + nonce กัน replay */
export type LineLoginState = {
  /** ปลายทางภายในหลัง login สำเร็จ (path เท่านั้น) */
  redirect: string;
  /** ค่าสุ่มผูก request นี้ (คู่กับ cookie) */
  nonce: string;
  exp: number;
};
