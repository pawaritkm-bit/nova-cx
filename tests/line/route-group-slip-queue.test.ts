import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression — บั๊กที่ผู้ใช้เจอ 2026-09-02 ("มีบิลส่งเข้าในกลุ่มแล้ว ทำไม ai ไม่ดึงบิลเข้า"):
 * สลิปแรกในกลุ่มรวมหลายบริษัท (route_by_slip) ค้าง pending ตลอด เพราะ 2 จุด:
 *  1) attachments.ts เกต real-time extraction เช็คแค่ group.customer_id —
 *     กลุ่มรวมตั้งใจให้ customer_id ว่าง → ไม่เคยถูกอ่านทันที (และ cron ตามเวลาปิดอยู่)
 *  2) bill-extract-worker: doc_kind 'slip' ไม่อยู่ในชนิดที่เข้าคิวสกัด —
 *     กลุ่มรวมเอกสารหลักคือสลิป ต้อง eligible (เฉพาะกลุ่ม route_by_slip เท่านั้น
 *     กลุ่มปกติคงเดิม ไม่เพิ่มต้นทุน AI)
 */
const ROOT = join(__dirname, "..", "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("กลุ่มรวมหลายบริษัท (route_by_slip): สลิปต้องถูกอ่านอัตโนมัติ", () => {
  it("attachments.ts เกต real-time ต้องรวมกลุ่ม route_by_slip (ไม่ใช่เช็คแค่ customer_id)", () => {
    const s = src("lib/line/attachments.ts");
    expect(s).toMatch(/group\.customer_id\s*\|\|\s*group\.route_by_slip/);
    // select ต้องดึงธง route_by_slip มาด้วย ไม่งั้นเกตไม่มีข้อมูลให้เช็ค
    expect(s).toMatch(/id, customer_id, route_by_slip, group_ref/);
  });

  it("worker มี ROUTE_GROUP_DOC_KINDS ที่รวม 'slip' และใช้ทั้ง query กลุ่ม + query สแกน", () => {
    const s = src("lib/line/bill-extract-worker.ts");
    expect(s).toMatch(/ROUTE_GROUP_DOC_KINDS\s*=\s*\[\.\.\.EXTRACT_ELIGIBLE_DOC_KINDS,\s*"slip"\]/);
    // ใช้จริงอย่างน้อย 2 จุด (group-scoped + สแกนกลุ่ม route)
    const uses = s.match(/\.in\("doc_kind", ROUTE_GROUP_DOC_KINDS\)|kinds = ROUTE_GROUP_DOC_KINDS/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it("กลุ่มปกติยังไม่อ่านสลิปอัตโนมัติ (ชนิดหลักคงเดิม — ไม่มี slip)", () => {
    const s = src("lib/line/bill-extract-worker.ts");
    expect(s).toMatch(/EXTRACT_ELIGIBLE_DOC_KINDS\s*=\s*\[\.\.\.BILL_DOC_KINDS,\s*"file"\]/);
    expect(s).toMatch(/BILL_DOC_KINDS\s*=\s*\["sale",\s*"purchase",\s*"handwritten",\s*"cash"\]/);
  });
});
