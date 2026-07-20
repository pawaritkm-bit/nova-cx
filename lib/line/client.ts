import { getLineOaCredentials, type LineOa } from "@/lib/env";
import type { LineMessage } from "@/lib/line/messages";

/**
 * LINE Messaging API client ต่อ OA (Care/Sale)
 *   - push / reply / (multicast เผื่ออนาคต)
 *   - เลือก access token ตาม OA จาก env
 *   - degrade สุภาพ: ไม่มี credential → getLineClient คืน null (worker จะ skip ไม่ crash)
 *
 * secret มาจาก env เท่านั้น (C-14)
 */

const LINE_API_BASE = "https://api.line.me/v2/bot";

export type LineSendResult =
  | { ok: true; messageId?: string }
  | { ok: false; status?: number; error: string; retryable: boolean };

export type LineProfile = { userId: string; displayName?: string };

/** สรุปข้อมูลกลุ่ม LINE (ชื่อกลุ่ม + รูป) จาก group summary API */
export type LineGroupSummary = { groupName: string; pictureUrl?: string };

export type LineClient = {
  oa: LineOa;
  /** push ไปยัง userId / groupId / roomId */
  push(to: string, messages: LineMessage[]): Promise<LineSendResult>;
  /** ตอบกลับด้วย replyToken (ใช้ได้ครั้งเดียว/หมดอายุเร็ว) */
  reply(replyToken: string, messages: LineMessage[]): Promise<LineSendResult>;
  /** ดึงโปรไฟล์ผู้ใช้ (best-effort) — คืน null ถ้าล้ม */
  getProfile(userId: string): Promise<LineProfile | null>;
  /**
   * ดึงโปรไฟล์สมาชิกในกลุ่ม/ห้อง (best-effort) — คืน null ถ้าล้ม
   *   endpoint แยกจาก getProfile: /group/{groupId}/member/{userId} หรือ /room/{roomId}/member/{userId}
   */
  getGroupMemberProfile(
    sourceType: "group" | "room",
    sourceId: string,
    userId: string
  ): Promise<LineProfile | null>;
  /**
   * ดึงสรุปข้อมูลกลุ่ม (ชื่อกลุ่ม/รูป) แบบ best-effort — คืน null ถ้าล้ม/ไม่ใช่กลุ่ม
   *   endpoint: GET /group/{groupId}/summary (ต้อง Verified/Premium OA)
   *   ★ room ไม่มี summary API → caller ต้องเรียกเฉพาะ group
   */
  getGroupSummary(groupId: string): Promise<LineGroupSummary | null>;
};

/** จำแนกว่า HTTP status ควร retry ไหม (5xx/429 = retry, 4xx อื่น = ไม่) */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function callLineApi(
  accessToken: string,
  path: string,
  body: unknown
): Promise<LineSendResult> {
  let res: Response;
  try {
    res = await fetch(`${LINE_API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // network error → retry ได้
    return {
      ok: false,
      error: e instanceof Error ? e.message : "network_error",
      retryable: true,
    };
  }

  if (res.ok) {
    // Messaging API push คืน 200 (message id อยู่ใน header x-line-request-id)
    const messageId = res.headers.get("x-line-request-id") ?? undefined;
    return { ok: true, messageId };
  }

  let detail = "";
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  return {
    ok: false,
    status: res.status,
    error: `line_api_${res.status}: ${detail.slice(0, 300)}`,
    retryable: isRetryableStatus(res.status),
  };
}

/**
 * คืน client ของ OA — null ถ้ายังไม่ตั้ง credential (degrade)
 * inject accessToken override ได้ (เผื่อ test) แต่ปกติอ่านจาก env
 */
export function getLineClient(oa: LineOa): LineClient | null {
  const creds = getLineOaCredentials(oa);
  if (!creds) return null;

  const token = creds.channelAccessToken;

  return {
    oa,
    push(to, messages) {
      return callLineApi(token, "/message/push", { to, messages });
    },
    reply(replyToken, messages) {
      return callLineApi(token, "/message/reply", { replyToken, messages });
    },
    async getProfile(userId) {
      try {
        const res = await fetch(`${LINE_API_BASE}/profile/${encodeURIComponent(userId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { userId: string; displayName?: string };
        return { userId: data.userId, displayName: data.displayName };
      } catch {
        return null;
      }
    },
    async getGroupMemberProfile(sourceType, sourceId, userId) {
      try {
        const path = `/${sourceType}/${encodeURIComponent(sourceId)}/member/${encodeURIComponent(userId)}`;
        const res = await fetch(`${LINE_API_BASE}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { userId: string; displayName?: string };
        return { userId: data.userId, displayName: data.displayName };
      } catch {
        return null;
      }
    },
    async getGroupSummary(groupId) {
      try {
        const res = await fetch(
          `${LINE_API_BASE}/group/${encodeURIComponent(groupId)}/summary`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        // ไม่ผ่าน (เช่น 404 = ไม่ใช่กลุ่ม/บอทไม่อยู่ในกลุ่ม, 403 = OA ไม่ verified) → null
        if (!res.ok) return null;
        const data = (await res.json()) as { groupName?: string; pictureUrl?: string };
        // ไม่มีชื่อกลุ่ม = ถือว่าดึงไม่ได้ (ไม่คืน object เปล่า)
        if (!data.groupName) return null;
        return { groupName: data.groupName, pictureUrl: data.pictureUrl };
      } catch {
        return null;
      }
    },
  };
}
