/**
 * statement-album.ts — รวมสเตทเมนต์ "หลายรูปชุดเดียวกัน" เป็นไฟล์สรุปเดียว
 *
 * ลูกค้าส่งสเตทเมนต์เป็นรูปหลายใบในคราวเดียว (รูปชุดเดียวกัน) — เดิมระบบอ่านทีละรูป
 * แล้วสร้างไฟล์สรุปต่อรูป = ไฟล์เยอะรก. โมดูลนี้จับ "รูปชุดเดียวกัน" ด้วย **วันที่ส่ง**
 * (ต่อลูกค้า/OA) แล้วสะสมธุรกรรมของทุกรูปในวันเดียวกัน → รีเจนไฟล์สรุปเดียว
 *   ★ กันรูปซ้ำ: dedup ธุรกรรม (วันที่+ทิศทาง+ยอด+รายละเอียด+คู่ค้า) → ส่งรูปเดิมซ้ำ = ไม่เพิ่มรายการ
 *   ★ logic ที่นี่เป็น pure (ทดสอบได้) — I/O (download/upload OneDrive) อยู่ที่ auto-read.ts
 */
import type { StatementTxn } from "@/lib/accounting/statement-analyze";

/**
 * คีย์ "อัลบั้ม" = วันที่ส่ง (YYYY-MM-DD) — รูปที่ส่งวันเดียวกันของลูกค้าเดียวกัน = ชุดเดียวกัน
 *   ★ ใช้เวลา "ส่งเข้า" (sent_at) ไม่ใช่วันที่ในสเตทเมนต์ · robust ข้าม cron (ไม่พึ่ง in-memory window)
 *   sent_at ว่าง/พังรูปแบบ → "unknown" (ยังรวมได้ในกองเดียว ดีกว่าแตกไฟล์)
 */
export function sessionDateKey(sentAt: string | null | undefined): string {
  if (!sentAt) return "unknown";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(sentAt.trim());
  return m ? m[1] : "unknown";
}

/** normalize string สำหรับเทียบ (ตัดช่องว่างซ้ำ/หัวท้าย, พิมพ์เล็ก) */
function norm(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** คีย์ dedup 1 ธุรกรรม — วันที่+ทิศทาง+ยอด+รายละเอียด+คู่ค้า (แม่นพอกันรูปเดิมซ้ำ ไม่ตัดรายการจริง) */
export function txnKey(t: StatementTxn): string {
  const amt = typeof t.amount === "number" ? t.amount.toFixed(2) : "";
  return [t.date ?? "", t.direction ?? "", amt, norm(t.description), norm(t.counterparty_name)].join("|");
}

/**
 * รวมธุรกรรมใหม่เข้ากองเดิม (dedup) — คืนกองรวม + จำนวนที่เพิ่มจริง
 *   added=0 = รูปนี้ไม่มีอะไรใหม่ (น่าจะรูปซ้ำ/หน้าเดิม) → ผู้เรียกข้ามการรีเจนได้
 */
export function mergeTxns(
  existing: StatementTxn[],
  incoming: StatementTxn[]
): { merged: StatementTxn[]; added: number } {
  const seen = new Set(existing.map(txnKey));
  const merged = existing.slice();
  let added = 0;
  for (const t of incoming) {
    const k = txnKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(t);
    added++;
  }
  return { merged, added };
}

/** serialize กอง txns → Buffer (เก็บเป็น JSON sidecar ในโฟลเดอร์ย่อย _album) */
export function serializeAlbum(txns: StatementTxn[]): Buffer {
  return Buffer.from(JSON.stringify({ v: 1, txns }), "utf8");
}

/** parse Buffer กลับเป็นกอง txns · null/พัง → [] (เริ่มกองใหม่) */
export function parseAlbum(buf: Buffer | null): StatementTxn[] {
  if (!buf) return [];
  try {
    const o = JSON.parse(buf.toString("utf8")) as { txns?: unknown };
    return Array.isArray(o.txns) ? (o.txns as StatementTxn[]) : [];
  } catch {
    return [];
  }
}

/** ชื่อไฟล์ JSON สะสม (อยู่ในโฟลเดอร์ย่อย _album — ไม่รกโฟลเดอร์สรุป) */
export function albumJsonName(dateKey: string): string {
  return `statement-${dateKey}.json`;
}

/** ชื่อไฟล์ CSV สรุปที่นักบัญชีเห็น (ไฟล์เดียวต่อชุด/วัน) */
export function albumCsvName(dateKey: string): string {
  return `สเตทเมนต์รวม ${dateKey}.csv`;
}
