/**
 * statement-album.ts — รวมสเตทเมนต์ทุกไฟล์/รูปของลูกค้า 1 ราย เป็น "ไฟล์สรุป Excel เดียว แยกตามธนาคาร"
 *
 * ลูกค้าส่งสเตทเมนต์หลายไฟล์ (PDF/รูป) และอาจมีหลายธนาคาร — เดิมระบบอ่านทีละไฟล์แล้วสร้างไฟล์สรุป
 * ต่อไฟล์ = ไฟล์เยอะรก. โมดูลนี้สะสมธุรกรรมทุกไฟล์ลง "กองต่อธนาคาร" (store JSON) แล้วรีเจน Excel
 * สรุปไฟล์เดียว 1 ชีต/ธนาคาร ทุกครั้งที่มีไฟล์ใหม่เข้ามา
 *   ★ กันไฟล์/รูปซ้ำ: dedup ธุรกรรม (วันที่+ทิศทาง+ยอด+รายละเอียด+คู่ค้า) ต่อธนาคาร → ส่งซ้ำ = ไม่เพิ่มรายการ
 *   ★ logic ที่นี่ pure (ทดสอบได้) — I/O OneDrive + สร้าง Excel อยู่ที่ผู้เรียก (auto-read.ts / statement-album-excel.ts)
 */
import type { StatementTxn } from "@/lib/accounting/statement-analyze";

/** กองสะสมสเตทเมนต์ของลูกค้า 1 ราย — แยกตามป้ายธนาคาร */
export type AlbumStore = { v: number; banks: Record<string, StatementTxn[]> };

/** ป้ายธนาคารเริ่มต้นเมื่ออ่านชื่อธนาคารไม่ได้ (เช่นรูปถ่าย) */
export const UNKNOWN_BANK = "ไม่ระบุธนาคาร";

/** normalize string สำหรับเทียบ (ตัดช่องว่างซ้ำ/หัวท้าย, พิมพ์เล็ก) */
function norm(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** คีย์ dedup 1 ธุรกรรม — วันที่+ทิศทาง+ยอด+รายละเอียด+คู่ค้า (แม่นพอกันไฟล์เดิมซ้ำ ไม่ตัดรายการจริง) */
export function txnKey(t: StatementTxn): string {
  const amt = typeof t.amount === "number" ? t.amount.toFixed(2) : "";
  return [t.date ?? "", t.direction ?? "", amt, norm(t.description), norm(t.counterparty_name)].join("|");
}

/** store ว่าง */
export function emptyAlbum(): AlbumStore {
  return { v: 2, banks: {} };
}

/** parse Buffer → AlbumStore · null/พัง → ว่าง (เริ่มกองใหม่ ไม่ throw) */
export function parseAlbumStore(buf: Buffer | null): AlbumStore {
  if (!buf) return emptyAlbum();
  try {
    const o = JSON.parse(buf.toString("utf8")) as Partial<AlbumStore>;
    if (o && typeof o === "object" && o.banks && typeof o.banks === "object") {
      return { v: 2, banks: o.banks as Record<string, StatementTxn[]> };
    }
    return emptyAlbum();
  } catch {
    return emptyAlbum();
  }
}

export function serializeAlbumStore(store: AlbumStore): Buffer {
  return Buffer.from(JSON.stringify(store), "utf8");
}

/**
 * รวมธุรกรรมใหม่เข้ากอง "ธนาคารหนึ่ง" (dedup) — คืน store ใหม่ + จำนวนที่เพิ่มจริง
 *   added=0 = ไม่มีอะไรใหม่ (ไฟล์ซ้ำ/หน้าเดิม) → ผู้เรียกข้ามการรีเจน Excel ได้
 *   ★ bankLabel ว่าง → UNKNOWN_BANK
 */
export function mergeIntoBank(
  store: AlbumStore,
  bankLabel: string | null | undefined,
  incoming: StatementTxn[]
): { store: AlbumStore; added: number } {
  const label = (bankLabel && bankLabel.trim()) || UNKNOWN_BANK;
  const banks: Record<string, StatementTxn[]> = { ...store.banks };
  const existing = banks[label] ?? [];
  const seen = new Set(existing.map(txnKey));
  const next = existing.slice();
  let added = 0;
  for (const t of incoming) {
    const k = txnKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    next.push(t);
    added++;
  }
  banks[label] = next;
  return { store: { v: 2, banks }, added };
}

/** ชื่อไฟล์ store JSON (อยู่ในโฟลเดอร์ย่อย _album — ไม่รกโฟลเดอร์สรุป) — 1 ไฟล์/ลูกค้า */
export const albumStoreName = "statement-banks.json";

/** ชื่อไฟล์ Excel สรุปที่นักบัญชีเห็น — 1 ไฟล์/ลูกค้า (แยกชีตตามธนาคารข้างใน) */
export function albumXlsxName(customerName: string): string {
  const safe = (customerName || "ลูกค้า").trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").slice(0, 80);
  return `${safe} - สรุปสเตทเมนต์.xlsx`;
}
