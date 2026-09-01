// Backfill: บิลเดิมที่แชร์ PDF ก้อนเดียวกัน → ตัดรูปรายหน้า 1 รูป/บิล (requirement 2026-09-01)
//   เงื่อนไขเดียวกับของใหม่: จำนวนหน้า PDF = จำนวนบิลจากไฟล์นั้น → map หน้า i ให้บิลลำดับ i
//   (ลำดับบิล = created_at เก่า→ใหม่ ตรงกับลำดับที่ worker สร้างจาก bills[0..N-1])
// ใช้: CUSTOMER=N221 DRY_RUN=false node scripts/backfill-pdf-page-images.mjs
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPageAsImage, getDocumentProxy } from 'unpdf';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const CUSTOMER_CODE = process.env.CUSTOMER || 'N221';

const envPath = path.join(os.homedir(), 'Desktop', 'โปรแกรม ai', 'nova-cx', '.env.local');
const env = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const hj = { ...h, 'Content-Type': 'application/json', Prefer: 'return=representation' };

const q = async (t, p) => {
  const r = await fetch(`${URL}/rest/v1/${t}?${p}`, { headers: h });
  if (!r.ok) throw new Error(`GET ${t} ${r.status} ${await r.text()}`);
  return r.json();
};

console.log(`\n${'='.repeat(64)}`);
console.log(`  Backfill รูปรายหน้าให้บิล PDF เดิม — ลูกค้า ${CUSTOMER_CODE} — ${DRY_RUN ? '🔍 DRY RUN' : '⚡ LIVE'}`);
console.log(`${'='.repeat(64)}\n`);

const [cust] = await q('customers', `customer_code=eq.${CUSTOMER_CODE}&deleted_at=is.null&select=id,tenant_id,name`);
if (!cust) { console.log('ไม่พบลูกค้า'); process.exit(1); }
console.log('ลูกค้า:', cust.name);

// บิลที่ยังชี้ PDF (แชร์ก้อนเดียวกันได้หลายใบ)
const entries = await q('bill_entries',
  `customer_id=eq.${cust.id}&deleted_at=is.null&upload_path=not.is.null&select=id,upload_path,upload_name,upload_mime,created_at&order=created_at.asc`);
const pdfEntries = entries.filter(e => /pdf/i.test(e.upload_mime ?? '') || /[._]pdf$/i.test(e.upload_path ?? ''));
console.log(`บิลที่ยังเป็น PDF: ${pdfEntries.length} ใบ`);

const groups = new Map();
for (const e of pdfEntries) {
  if (!groups.has(e.upload_path)) groups.set(e.upload_path, []);
  groups.get(e.upload_path).push(e);
}

for (const [pdfPath, list] of groups) {
  const base = (list[0].upload_name || 'บิล').replace(/\.pdf$/i, '');
  // ดาวน์โหลด PDF
  const dl = await fetch(`${URL}/storage/v1/object/bills/${pdfPath}`, { headers: h });
  if (!dl.ok) { console.log(`  ⚠ ${base}: ดาวน์โหลดไม่ได้ (${dl.status}) — ข้าม`); continue; }
  const buf = Buffer.from(await dl.arrayBuffer());
  let pages;
  try {
    pages = (await getDocumentProxy(new Uint8Array(buf))).numPages;
  } catch { console.log(`  ⚠ ${base}: เปิด PDF ไม่ได้ — ข้าม`); continue; }

  if (pages !== list.length) {
    console.log(`  ⚠ ${base}: ${pages} หน้า ≠ ${list.length} บิล — ข้าม (map ไม่ได้)`);
    continue;
  }
  console.log(`  ${base}: ${pages} หน้า = ${list.length} บิล → ตัดรูป`);

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const pngPath = `${pdfPath}.p${i + 1}.png`;
    if (DRY_RUN) { console.log(`    [DRY] หน้า ${i + 1} → entry ${e.id.slice(0, 8)}`); continue; }
    const img = await renderPageAsImage(new Uint8Array(buf), i + 1, {
      canvasImport: () => import('@napi-rs/canvas'), scale: 2,
    });
    const up = await fetch(`${URL}/storage/v1/object/bills/${pngPath}`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'image/png', 'x-upsert': 'true' },
      body: Buffer.from(img),
    });
    if (!up.ok) { console.log(`    ⚠ หน้า ${i + 1}: อัปรูปไม่สำเร็จ (${up.status}) — คง PDF เดิม`); continue; }
    const pa = await fetch(`${URL}/rest/v1/bill_entries?id=eq.${e.id}&tenant_id=eq.${cust.tenant_id}`, {
      method: 'PATCH', headers: hj,
      body: JSON.stringify({
        upload_path: pngPath,
        upload_name: `${base} (หน้า ${i + 1}).png`,
        upload_mime: 'image/png',
      }),
    });
    console.log(`    ${pa.ok ? '✓' : '⚠'} หน้า ${i + 1} → entry ${e.id.slice(0, 8)}`);
  }
}
console.log(`\n${'='.repeat(64)}\n  ${DRY_RUN ? 'DRY RUN จบ — รัน DRY_RUN=false เพื่อทำจริง' : 'Done'}\n${'='.repeat(64)}\n`);
