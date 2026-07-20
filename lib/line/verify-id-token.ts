/**
 * verify LINE ID token ฝั่ง server
 *
 * บริบทความปลอดภัย: client (LIFF) ส่ง idToken (JWT) มาให้ ห้ามเชื่อ userId ที่ client
 *   claim ตรง ๆ (spoof ได้) — ต้อง verify กับ LINE เพื่อดึง `sub` (= LINE userId จริง)
 *
 * เอกสาร: POST https://api.line.me/oauth2/v2.1/verify
 *   body (x-www-form-urlencoded): id_token=<jwt>&client_id=<login channel id>
 *   สำเร็จ → JSON { iss, sub, aud, exp, name?, picture?, ... }
 *     - `sub` = LINE userId (ตัวที่เราต้องใช้ผูกพนักงาน)
 *     - LINE ตรวจ signature/aud/exp ให้แล้ว; เราตรวจซ้ำ aud === client_id กันเหนียว
 *
 * ทุกความล้มเหลว → คืน null (route แปลงเป็น 401) ไม่ throw เพื่อไม่ให้รั่ว detail
 */

const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";

export type VerifiedLineIdentity = {
  /** LINE userId จริง (claim `sub`) */
  userId: string;
  /** ชื่อที่แสดงบน LINE (claim `name`) — best-effort สำหรับ prefill/audit */
  name?: string;
};

/** fetch แบบฉีดได้ (test mock) — default = global fetch */
type FetchLike = typeof fetch;

export async function verifyLineIdToken(
  idToken: string,
  channelId: string,
  fetchImpl: FetchLike = fetch
): Promise<VerifiedLineIdentity | null> {
  const token = idToken?.trim();
  const clientId = channelId?.trim();
  if (!token || !clientId) return null;

  try {
    const res = await fetchImpl(LINE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: token, client_id: clientId }).toString(),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      sub?: unknown;
      aud?: unknown;
      name?: unknown;
    };

    const userId = typeof data.sub === "string" ? data.sub.trim() : "";
    if (!userId) return null;

    // ★ [sec-b] aud ต้องเป็น string ที่ตรง client_id "เป๊ะ" เท่านั้น —
    //   ปฏิเสธทุกกรณีที่ไม่ตรง (aud หายไป/ไม่ใช่ string/เป็น array/คนละค่า)
    //   clientId เป็น string เสมอ → เทียบตรง ๆ ครอบคลุมทุกเคสข้างต้น (fail-closed)
    if (data.aud !== clientId) return null;

    const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined;
    return { userId, name };
  } catch {
    // network/parse error → ถือว่า verify ไม่ผ่าน (fail-closed)
    return null;
  }
}
