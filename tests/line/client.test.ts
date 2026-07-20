import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getLineClient } from "@/lib/line/client";

/**
 * getGroupSummary — ดึงชื่อกลุ่ม LINE (best-effort)
 *   ครอบคลุม: parse groupName/pictureUrl สำเร็จ, ไม่ผ่าน (404/403) → null,
 *   ไม่มี groupName → null, network error → null, เรียก endpoint ถูก + ใส่ Bearer token
 */

const CARE_SECRET = "care-secret";
const CARE_TOKEN = "care-access-token";

function setCareEnv() {
  process.env.LINE_CARE_CHANNEL_SECRET = CARE_SECRET;
  process.env.LINE_CARE_CHANNEL_ACCESS_TOKEN = CARE_TOKEN;
}

describe("getLineClient.getGroupSummary", () => {
  const prevSecret = process.env.LINE_CARE_CHANNEL_SECRET;
  const prevToken = process.env.LINE_CARE_CHANNEL_ACCESS_TOKEN;

  beforeEach(() => {
    setCareEnv();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prevSecret === undefined) delete process.env.LINE_CARE_CHANNEL_SECRET;
    else process.env.LINE_CARE_CHANNEL_SECRET = prevSecret;
    if (prevToken === undefined) delete process.env.LINE_CARE_CHANNEL_ACCESS_TOKEN;
    else process.env.LINE_CARE_CHANNEL_ACCESS_TOKEN = prevToken;
  });

  it("200 → parse { groupName, pictureUrl } + เรียก summary endpoint ด้วย Bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ groupId: "Cabc", groupName: "บจ.นอร่า299", pictureUrl: "https://pic" }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = getLineClient("care");
    expect(client).not.toBeNull();
    const summary = await client!.getGroupSummary("Cabc");
    expect(summary).toEqual({ groupName: "บจ.นอร่า299", pictureUrl: "https://pic" });

    // เรียก endpoint /group/{groupId}/summary + ใส่ Authorization: Bearer
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.line.me/v2/bot/group/Cabc/summary");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CARE_TOKEN}`);
  });

  it("ไม่ผ่าน (404 = บอทไม่อยู่ในกลุ่ม) → null (ไม่ throw)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    const client = getLineClient("care");
    expect(await client!.getGroupSummary("Cabc")).toBeNull();
  });

  it("200 แต่ไม่มี groupName → null (ไม่คืน object เปล่า)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ groupId: "Cabc" }), { status: 200 })));
    const client = getLineClient("care");
    expect(await client!.getGroupSummary("Cabc")).toBeNull();
  });

  it("network error → null (best-effort, ไม่ throw)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const client = getLineClient("care");
    expect(await client!.getGroupSummary("Cabc")).toBeNull();
  });
});
