import { describe, it, expect } from "vitest";
import { extractLiffToken, firstQueryValue } from "@/lib/line/liff";
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
