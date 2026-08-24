/**
 * platform-album.ts — รวมรายงานแพลตฟอร์มทุกไฟล์ของลูกค้า 1 ราย → ไฟล์สรุปเดียว
 *   แยกตามแบบที่ NOVA Sale อ่าน: 4 ตัวเลข (ยอดขาย/ค่าธรรมเนียม-GP/ค่าขนส่ง/ส่วนลด) × ต่อแพลตฟอร์ม + รายเดือน
 *   ★ dedup ระดับไฟล์ (sig = แพลตฟอร์ม+ตัวเลขรวม) กันไฟล์เดิมส่งซ้ำ · logic pure (ทดสอบได้)
 */

export type PlatformMonthFig = {
  month: string; // 'YYYY-MM' หรือ 'unknown'
  grossSales: number;
  platformFee: number;
  shippingFee: number;
  discount: number;
};
/** 1 ไฟล์รายงาน = แพลตฟอร์ม + ยอดแยกเดือน (sig ใช้ dedup ไฟล์ซ้ำ) */
export type PlatformFileRecord = { sig: string; platform: string; months: PlatformMonthFig[] };
export type PlatformAlbumStore = { v: number; files: PlatformFileRecord[] };

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
/** สุทธิ = ยอดขาย − ค่าธรรมเนียม − ค่าขนส่ง − ส่วนลด */
export function netOf(f: { grossSales: number; platformFee: number; shippingFee: number; discount: number }): number {
  return r2(f.grossSales - f.platformFee - f.shippingFee - f.discount);
}

export function emptyPlatformAlbum(): PlatformAlbumStore {
  return { v: 1, files: [] };
}

/** สร้าง record จากผลอ่านไฟล์ (figures + monthly ถ้ามี) */
export function toPlatformRecord(
  platform: string,
  figures: { grossSales: number; platformFee: number; shippingFee: number; discount: number; monthly?: PlatformMonthFig[] },
): PlatformFileRecord {
  const sig = [platform, r2(figures.grossSales), r2(figures.platformFee), r2(figures.shippingFee), r2(figures.discount)].join("|");
  const months: PlatformMonthFig[] = figures.monthly && figures.monthly.length
    ? figures.monthly.map((m) => ({ month: m.month || "unknown", grossSales: r2(m.grossSales), platformFee: r2(Math.abs(m.platformFee)), shippingFee: r2(Math.abs(m.shippingFee)), discount: r2(Math.abs(m.discount)) }))
    : [{ month: "unknown", grossSales: r2(figures.grossSales), platformFee: r2(figures.platformFee), shippingFee: r2(figures.shippingFee), discount: r2(figures.discount) }];
  return { sig, platform, months };
}

/** รวม record เข้ากอง (dedup ด้วย sig) — added=false ถ้าไฟล์นี้เคยรวมแล้ว */
export function mergePlatformFile(store: PlatformAlbumStore, rec: PlatformFileRecord): { store: PlatformAlbumStore; added: boolean } {
  if (store.files.some((f) => f.sig === rec.sig)) return { store, added: false };
  return { store: { v: 1, files: [...store.files, rec] }, added: true };
}

export type PlatformTotals = { grossSales: number; platformFee: number; shippingFee: number; discount: number; net: number };

function sumMonths(months: PlatformMonthFig[]): Omit<PlatformTotals, "net"> {
  const t = { grossSales: 0, platformFee: 0, shippingFee: 0, discount: 0 };
  for (const m of months) { t.grossSales += m.grossSales; t.platformFee += m.platformFee; t.shippingFee += m.shippingFee; t.discount += m.discount; }
  return { grossSales: r2(t.grossSales), platformFee: r2(t.platformFee), shippingFee: r2(t.shippingFee), discount: r2(t.discount) };
}

/** สรุปต่อแพลตฟอร์ม (เรียงชื่อ) */
export function byPlatform(store: PlatformAlbumStore): { platform: string; totals: PlatformTotals }[] {
  const map = new Map<string, PlatformMonthFig[]>();
  for (const f of store.files) map.set(f.platform, [...(map.get(f.platform) ?? []), ...f.months]);
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([platform, months]) => {
    const s = sumMonths(months);
    return { platform, totals: { ...s, net: netOf(s) } };
  });
}

/** สรุปรายเดือน (รวมทุกแพลตฟอร์ม เรียงเดือน · 'unknown' ท้ายสุด) */
export function byMonth(store: PlatformAlbumStore): { month: string; totals: PlatformTotals }[] {
  const map = new Map<string, PlatformMonthFig[]>();
  for (const f of store.files) for (const m of f.months) map.set(m.month, [...(map.get(m.month) ?? []), m]);
  return [...map.entries()]
    .sort((a, b) => (a[0] === "unknown" ? 1 : b[0] === "unknown" ? -1 : a[0].localeCompare(b[0])))
    .map(([month, months]) => { const s = sumMonths(months); return { month, totals: { ...s, net: netOf(s) } }; });
}

/** ยอดรวมทั้งหมด */
export function grandTotals(store: PlatformAlbumStore): PlatformTotals {
  const s = sumMonths(store.files.flatMap((f) => f.months));
  return { ...s, net: netOf(s) };
}
