/**
 * ตัด id list เป็นก้อนละ ≤ CHUNK_SIZE — กัน `.in("col", ids)` สร้าง URL ยาวเกิน limit ของ PostgREST
 *   (พบจริง 2026-08-10: tenant ที่มีบิลสะสมมาก — มุมมอง "ทั้งสำนักงาน" มี ids หลักร้อย/พัน → รวมเป็น
 *   query string ยาวเกิน request-URI limit → PostgREST ตอบ 400 Bad Request เงียบ ๆ กลายเป็นข้อมูลหาย
 *   ทั้งหน้าแม้ DB ถูกต้อง 100% — ดู commit 7ab9f91 (แก้จุดแรกใน listEntries()) และ docs/06 ส่วนที่เกี่ยวข้อง)
 *   ใช้ร่วมกันทุกจุดที่ทำ `.in(col, ids)` โดย ids มาจาก list ที่ไม่มีเพดานตายตัว (ทั้ง tenant/ทั้งลูกค้า)
 */
export const ID_CHUNK_SIZE = 150;

export function chunkIds(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) out.push(ids.slice(i, i + ID_CHUNK_SIZE));
  return out;
}
