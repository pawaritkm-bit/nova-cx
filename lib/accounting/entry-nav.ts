/**
 * ลงบันทึกบัญชี — ตัวช่วยนำทาง "ก่อนหน้า/ถัดไป" ในหน้าแก้บิล (pure, ทดสอบได้)
 *
 * ★ orderIds = ลำดับ entry id ของบริบทที่กำลังดู (ลูกค้าเดียวกัน + แท็บ/type เดียวกัน)
 *   เรียงเหมือนในตาราง — page.tsx เป็นผู้ส่งมาให้ (server เป็นเจ้าของลำดับ)
 * ★ ไม่มี dependency ภายนอก — รับ array + id ปัจจุบัน แล้วคืนตำแหน่ง + id ก่อน/ถัดไป
 */

export type EntryNav = {
  /** ตำแหน่งปัจจุบัน (1-based) — 0 ถ้าหา id ปัจจุบันไม่เจอในลำดับ */
  position: number;
  /** จำนวนบิลทั้งหมดในบริบทนี้ */
  total: number;
  /** id ของบิลก่อนหน้า (null = ใบแรก/ไม่พบ) */
  prevId: string | null;
  /** id ของบิลถัดไป (null = ใบสุดท้าย/ไม่พบ) */
  nextId: string | null;
};

/**
 * หาตำแหน่ง + ใบก่อนหน้า/ถัดไป ของ currentId ในลำดับ orderIds
 *   - ไม่พบ currentId → position=0, prev/next=null (ปิดปุ่มทั้งคู่)
 *   - ใบแรก → prevId=null · ใบสุดท้าย → nextId=null
 */
export function resolveEntryNav(orderIds: string[], currentId: string): EntryNav {
  const idx = orderIds.indexOf(currentId);
  if (idx === -1) {
    return { position: 0, total: orderIds.length, prevId: null, nextId: null };
  }
  return {
    position: idx + 1,
    total: orderIds.length,
    prevId: idx > 0 ? orderIds[idx - 1] : null,
    nextId: idx < orderIds.length - 1 ? orderIds[idx + 1] : null,
  };
}
