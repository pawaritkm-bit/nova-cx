import { describe, it, expect } from "vitest";
import { resolveEntryNav } from "@/lib/accounting/entry-nav";

/**
 * accounting/entry-nav — ลำดับ ก่อนหน้า/ถัดไป ในหน้าแก้บิล (pure)
 */

describe("resolveEntryNav — ตำแหน่ง + ใบก่อนหน้า/ถัดไป", () => {
  const ids = ["a", "b", "c"];

  it("ใบแรก → prev=null, next=ใบถัดไป, ตำแหน่ง 1/3", () => {
    const nav = resolveEntryNav(ids, "a");
    expect(nav.position).toBe(1);
    expect(nav.total).toBe(3);
    expect(nav.prevId).toBeNull();
    expect(nav.nextId).toBe("b");
  });

  it("ใบกลาง → prev/next ครบ, ตำแหน่ง 2/3", () => {
    const nav = resolveEntryNav(ids, "b");
    expect(nav.position).toBe(2);
    expect(nav.prevId).toBe("a");
    expect(nav.nextId).toBe("c");
  });

  it("ใบสุดท้าย → next=null, ตำแหน่ง 3/3", () => {
    const nav = resolveEntryNav(ids, "c");
    expect(nav.position).toBe(3);
    expect(nav.prevId).toBe("b");
    expect(nav.nextId).toBeNull();
  });

  it("มีใบเดียว → prev/next null ทั้งคู่", () => {
    const nav = resolveEntryNav(["x"], "x");
    expect(nav.position).toBe(1);
    expect(nav.total).toBe(1);
    expect(nav.prevId).toBeNull();
    expect(nav.nextId).toBeNull();
  });

  it("หา id ไม่เจอในลำดับ → position 0, prev/next null (ปิดปุ่ม)", () => {
    const nav = resolveEntryNav(ids, "zzz");
    expect(nav.position).toBe(0);
    expect(nav.total).toBe(3);
    expect(nav.prevId).toBeNull();
    expect(nav.nextId).toBeNull();
  });

  it("ลำดับว่าง → total 0, position 0", () => {
    const nav = resolveEntryNav([], "a");
    expect(nav.total).toBe(0);
    expect(nav.position).toBe(0);
    expect(nav.prevId).toBeNull();
    expect(nav.nextId).toBeNull();
  });
});
