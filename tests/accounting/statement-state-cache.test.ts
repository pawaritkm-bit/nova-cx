import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression — บั๊กที่ผู้ใช้เจอ 2026-09-02 ("ยังขึ้น 4010 อยู่เลย"):
 * ไฟล์สถานะ (review-state.json / *.txns.json) ถูก CDN ของ Supabase Storage แคชไว้
 * → หน้าเว็บโหลดฉบับเก่า แล้วเซฟทับค่าที่แก้แล้ว (4010→4030 เด้งกลับเป็น 4010)
 *
 * กติกาถาวร:
 *  1) ทุกจุดที่ "เซฟ" ไฟล์สถานะ ต้องตั้ง cacheControl: "0"
 *  2) ทุกจุดที่ "โหลด" ไฟล์สถานะ ต้องอ่านแบบสด (cache-buster + no-store) ห้ามใช้
 *     storage.download() ตรง ๆ กับไฟล์สถานะ
 */
const ROOT = join(__dirname, "..", "..");

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("ไฟล์สถานะสเตทเมนต์ ห้ามโดน CDN cache", () => {
  it("saveStatementReviewStateAction เซฟ review-state ด้วย cacheControl 0", () => {
    const s = src("app/chat-audit/accounting/statement-actions.ts");
    const saveFn = s.slice(s.indexOf("saveStatementReviewStateAction"));
    expect(saveFn).toMatch(/cacheControl:\s*"0"/);
  });

  it("โหลด review-state / sidecar ผ่านตัวอ่านสด (bypass cache) ไม่ใช่ download() ตรง", () => {
    const s = src("app/chat-audit/accounting/statement-actions.ts");
    // helper อ่านสดต้องมี cache-buster + no-store
    expect(s).toMatch(/downloadStorageFresh/);
    expect(s).toMatch(/fresh=\$\{Date\.now\(\)\}/);
    expect(s).toMatch(/cache:\s*"no-store"/);
    // จุดโหลดทั้งสอง (review-state + .txns.json) ต้องเรียก helper นี้
    const loadReview = s.slice(s.indexOf("loadStatementReviewStateAction"));
    expect(loadReview.slice(0, 1200)).toMatch(/downloadStorageFresh\(reviewStatePath/);
    expect(s).toMatch(/downloadStorageFresh\(p\.endsWith\("\.txns\.json"\)/);
    // ห้ามมี download() ของไฟล์สถานะหลงเหลือ
    expect(s).not.toMatch(/\.download\([^)]*review-state/);
    expect(s).not.toMatch(/\.download\([^)]*txns\.json/);
  });

  it("sidecar ผลอ่าน (extract-statement) เซฟด้วย cacheControl 0", () => {
    const s = src("app/api/accounting/extract-statement/route.ts");
    const i = s.indexOf(".txns.json`, Buffer.from(sidecar");
    expect(i).toBeGreaterThan(-1);
    expect(s.slice(i, i + 300)).toMatch(/cacheControl:\s*"0"/);
  });
});
