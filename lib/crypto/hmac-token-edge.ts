/**
 * โทเค็น HMAC-SHA256 เวอร์ชัน Edge (Web Crypto) — ใช้ใน middleware (edge runtime ใช้ node:crypto ไม่ได้)
 *
 * ★ 2026-09-03 ผู้ใช้: "กดยืนยันบิลแล้วโปรแกรมเด้งออก" — session นักบัญชี (LINE) อายุ 12 ชม.
 *   แบบตายตัว ไม่ต่ออายุ → ทำงานข้ามวันโดนเด้งไปหน้า login กลางคัน
 *   middleware ต้อง verify + re-sign (sliding session) ได้เอง จึงต้องมี HMAC ฝั่ง Web Crypto
 *
 * รูปแบบโทเค็นเดียวกับ lib/crypto/hmac-token.ts เป๊ะ: `<base64url(json)>.<base64url(hmac)>`
 *   → เซ็นด้วยฝั่งไหน อีกฝั่ง verify ได้เสมอ (มีเทสต์ cross-compat คุมไว้)
 */

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacSha256(body: string, secret: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return new Uint8Array(sig);
}

/** เทียบไบต์แบบ constant-time (edge ไม่มี timingSafeEqual) */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** เซ็นโทเค็น (รูปแบบเดียวกับ signToken ฝั่ง node) */
export async function signTokenEdge(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = toBase64Url(await hmacSha256(body, secret));
  return `${body}.${sig}`;
}

/** verify + parse (กติกาเดียวกับ verifyToken ฝั่ง node: ลายเซ็นก่อน → exp → payload) */
export async function verifyTokenEdge<T = Record<string, unknown>>(
  token: string | null | undefined,
  secret: string,
  now: number = nowSeconds()
): Promise<T | null> {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot >= token.length - 1) return null;

  const body = token.slice(0, dot);
  const sig = fromBase64Url(token.slice(dot + 1));
  if (!sig) return null;
  const expected = await hmacSha256(body, secret);
  if (!constantTimeEqual(sig, expected)) return null;

  const raw = fromBase64Url(body);
  if (!raw) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp === "number" && now >= exp) return null;

  return payload as T;
}
