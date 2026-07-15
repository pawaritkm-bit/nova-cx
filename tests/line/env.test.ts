import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getLineOaCredentials,
  getLineChannelSecret,
  hasLineOaCredentials,
} from "@/lib/env";

describe("lib/env — LINE OA credentials", () => {
  const original = { ...process.env };

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("LINE_")) delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("ไม่มี env → null (degrade, ไม่ throw)", () => {
    expect(getLineOaCredentials("care")).toBeNull();
    expect(hasLineOaCredentials("care")).toBe(false);
  });

  it("มี secret แต่ขาด access token → null", () => {
    process.env.LINE_CARE_CHANNEL_SECRET = "s";
    expect(getLineOaCredentials("care")).toBeNull();
    // แต่ getLineChannelSecret ยังคืน secret ได้ (สำหรับ verify webhook)
    expect(getLineChannelSecret("care")).toBe("s");
  });

  it("ครบ → คืน credential + แยก OA (care/sale) ถูกต้อง", () => {
    process.env.LINE_CARE_CHANNEL_SECRET = "care-secret";
    process.env.LINE_CARE_CHANNEL_ACCESS_TOKEN = "care-token";
    process.env.LINE_SALE_CHANNEL_SECRET = "sale-secret";
    process.env.LINE_SALE_CHANNEL_ACCESS_TOKEN = "sale-token";

    const care = getLineOaCredentials("care");
    expect(care?.channelSecret).toBe("care-secret");
    expect(care?.channelAccessToken).toBe("care-token");

    const sale = getLineOaCredentials("sale");
    expect(sale?.channelSecret).toBe("sale-secret");
    expect(sale?.channelAccessToken).toBe("sale-token");

    expect(hasLineOaCredentials("care")).toBe(true);
    expect(hasLineOaCredentials("sale")).toBe(true);
  });
});
