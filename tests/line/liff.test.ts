import { describe, it, expect, vi } from "vitest";
import {
  extractLiffToken,
  firstQueryValue,
  getBestEffortLineUserId,
  hasOAuthReturnParams,
  resolveSurveyToken,
} from "@/lib/line/liff";
import { buildLiffSurveyUrl } from "@/lib/line/messages";

describe("line/liff — extractLiffToken", () => {
  it("อ่าน ?token= ตรง ๆ", () => {
    expect(extractLiffToken({ token: "abc" })).toBe("abc");
  });

  it("liff.state = '/abc' → 'abc' (ตัด / นำหน้า)", () => {
    expect(extractLiffToken({ liffState: "/abc" })).toBe("abc");
  });

  it("liff.state = '%2Fabc' (encoded) → 'abc' (url-decode + ตัด /)", () => {
    expect(extractLiffToken({ liffState: "%2Fabc" })).toBe("abc");
  });

  it("liff.state = 'abc' (ไม่มี /) → 'abc'", () => {
    expect(extractLiffToken({ liffState: "abc" })).toBe("abc");
  });

  it("liff.state พก query ต่อท้าย → เอาเฉพาะ token", () => {
    expect(extractLiffToken({ liffState: "/abc?foo=bar" })).toBe("abc");
  });

  it("?token= มาก่อน liff.state", () => {
    expect(extractLiffToken({ token: "direct", liffState: "/other" })).toBe(
      "direct"
    );
  });

  it("ไม่มี token เลย → null", () => {
    expect(extractLiffToken({})).toBeNull();
    expect(extractLiffToken({ token: "", liffState: "" })).toBeNull();
    expect(extractLiffToken({ token: "   " })).toBeNull();
  });

  it("token base64url (มี _ -) ผ่านได้ครบ", () => {
    const t = "aB3_x-Yz09";
    expect(extractLiffToken({ token: t })).toBe(t);
    expect(extractLiffToken({ liffState: `/${t}` })).toBe(t);
  });
});

describe("line/liff — firstQueryValue", () => {
  it("string เดี่ยว", () => {
    expect(firstQueryValue("a")).toBe("a");
  });
  it("array → ค่าแรก", () => {
    expect(firstQueryValue(["a", "b"])).toBe("a");
  });
  it("undefined → undefined", () => {
    expect(firstQueryValue(undefined)).toBeUndefined();
  });
});

describe("line/liff — hasOAuthReturnParams", () => {
  it("มี code → true", () => {
    expect(hasOAuthReturnParams({ code: "xyz" })).toBe(true);
  });
  it("มี state → true", () => {
    expect(hasOAuthReturnParams({ state: "s1" })).toBe(true);
  });
  it("มี liffRedirectUri → true", () => {
    expect(hasOAuthReturnParams({ liffRedirectUri: "https://x" })).toBe(true);
  });
  it("ว่างทั้งหมด/null → false", () => {
    expect(hasOAuthReturnParams({})).toBe(false);
    expect(
      hasOAuthReturnParams({ code: null, state: null, liffRedirectUri: null })
    ).toBe(false);
    expect(hasOAuthReturnParams({ code: "", state: "" })).toBe(false);
  });
});

describe("line/liff — resolveSurveyToken", () => {
  it("มี initial token → ใช้เลย (ไม่แตะ storage)", () => {
    expect(
      resolveSurveyToken({
        initialToken: "tok",
        storedToken: "other",
        isOAuthReturn: true,
      })
    ).toBe("tok");
  });

  it("ไม่มี initial + เพิ่งกลับจาก OAuth + มีใน storage → กู้จาก storage", () => {
    expect(
      resolveSurveyToken({
        initialToken: null,
        storedToken: "recovered",
        isOAuthReturn: true,
      })
    ).toBe("recovered");
  });

  it("ไม่มี initial + เพิ่งกลับจาก OAuth + storage ว่าง → null", () => {
    expect(
      resolveSurveyToken({
        initialToken: null,
        storedToken: null,
        isOAuthReturn: true,
      })
    ).toBeNull();
  });

  it("ไม่มี initial + ไม่ใช่ OAuth return → ไม่กู้จาก storage (null) กัน token เก่าค้าง", () => {
    expect(
      resolveSurveyToken({
        initialToken: null,
        storedToken: "stale",
        isOAuthReturn: false,
      })
    ).toBeNull();
  });

  it("trim ค่า", () => {
    expect(
      resolveSurveyToken({ initialToken: "  tok  ", isOAuthReturn: false })
    ).toBe("tok");
    expect(
      resolveSurveyToken({
        initialToken: "   ",
        storedToken: "  rec  ",
        isOAuthReturn: true,
      })
    ).toBe("rec");
  });
});

describe("line/liff — getBestEffortLineUserId (ห้ามเรียก login)", () => {
  it("ยังไม่ล็อกอิน → คืน null และ 'ไม่' เรียก login/getProfile", async () => {
    const login = vi.fn();
    const getProfile = vi.fn(async () => ({ userId: "u1" }));
    const liff = {
      init: vi.fn(async () => {}),
      isLoggedIn: () => false,
      getProfile,
      // แนบ login เข้ามาเพื่อยืนยันว่าโค้ด "ไม่" เรียก
      login,
    };
    const uid = await getBestEffortLineUserId(liff);
    expect(uid).toBeNull();
    expect(login).not.toHaveBeenCalled();
    expect(getProfile).not.toHaveBeenCalled();
  });

  it("ล็อกอินแล้ว → คืน userId จาก profile", async () => {
    const liff = {
      init: vi.fn(async () => {}),
      isLoggedIn: () => true,
      getProfile: vi.fn(async () => ({ userId: "line-123" })),
    };
    expect(await getBestEffortLineUserId(liff)).toBe("line-123");
  });

  it("getProfile โยน error → null (best-effort, ไม่ crash)", async () => {
    const liff = {
      init: vi.fn(async () => {}),
      isLoggedIn: () => true,
      getProfile: vi.fn(async () => {
        throw new Error("network");
      }),
    };
    expect(await getBestEffortLineUserId(liff)).toBeNull();
  });
});

describe("line/messages — buildLiffSurveyUrl (query-style)", () => {
  it("ใช้ ?token= (ไม่ใช่ path)", () => {
    expect(buildLiffSurveyUrl("liff-123", "tok")).toBe(
      "https://liff.line.me/liff-123?token=tok"
    );
  });

  it("encode token ที่มีอักขระพิเศษ", () => {
    expect(buildLiffSurveyUrl("liff-123", "a b")).toBe(
      "https://liff.line.me/liff-123?token=a%20b"
    );
  });
});
