// Backfill ขั้น 1: รีเซ็ตบิล PDF ชุดเดิมของ N221 (เฉพาะไฟล์ "ชุด*") ให้เป็นร่างเปล่า 1 ใบ/ไฟล์
//   เพื่อรัน pipeline ใหม่ (อ่านทีละหน้า = 1 บิล/หน้า พร้อมรูป) — ขั้น 2 อยู่ที่ตัวรัน vitest
//   ★ ไม่แตะไฟล์สเตทเมนต์ที่ถูกอัปเป็นบิล (เดือน เมย-69 ฯลฯ) — คนละเรื่อง แจ้งผู้ใช้แยก
// DRY_RUN=false node scripts/reset-pamee-pdf-bills.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const envPath = path.join(os.homedir(), 'Desktop', 'โปรแกรม ai', 'nova-cx', '.env.local');
const env = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const q = async (t, p) => {
  const r = await fetch(`${URL}/rest/v1/${t}?${p}`, { headers: h });
  if (!r.ok) throw new Error(`GET ${t} ${r.status} ${await r.text()}`);
  return r.json();
};

const [cust] = await q('customers', 'customer_code=eq.N221&deleted_at=is.null&select=id,tenant_id,name');
console.log('ลูกค้า:', cust.name, DRY_RUN ? '(DRY RUN)' : '(LIVE)');

const entries = await q('bill_entries',
  `customer_id=eq.${cust.id}&deleted_at=is.null&upload_path=not.is.null&select=id,upload_path,upload_name,upload_mime,entry_type,status&order=created_at.asc`);
// เฉพาะไฟล์บิลชุด (ชุด*) ที่ยังเป็นร่าง — ไม่แตะสเตทเมนต์/ใบที่ยืนยันแล้ว
const target = entries.filter(e => /pdf/i.test(e.upload_mime ?? '') && /^ชุด/.test(e.upload_name ?? '') && e.status === 'draft');
const groups = new Map();
for (const e of target) {
  if (!groups.has(e.upload_path)) groups.set(e.upload_path, { name: e.upload_name, type: e.entry_type, ids: [] });
  groups.get(e.upload_path).ids.push(e.id);
}
console.log('ไฟล์ที่จะรีเซ็ต:', groups.size, '| บิลร่างเดิมที่จะลบ (soft):', target.length);

const out = [];
for (const [pdfPath, g] of groups) {
  console.log(`- ${g.name}: ลบร่างเดิม ${g.ids.length} ใบ → สร้างร่างเปล่า 1 ใบ`);
  if (DRY_RUN) continue;
  // soft-delete ร่างเดิมทั้งกลุ่ม
  const del = await fetch(`${URL}/rest/v1/bill_entries?id=in.(${g.ids.join(',')})&tenant_id=eq.${cust.tenant_id}&status=eq.draft`, {
    method: 'PATCH', headers: h, body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  if (!del.ok) { console.log('  ⚠ ลบไม่สำเร็จ', del.status); continue; }
  // สร้างร่างเปล่าใหม่ 1 ใบชี้ PDF เดิม (เหมือนเพิ่งอัป)
  const insR = await fetch(`${URL}/rest/v1/bill_entries`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      tenant_id: cust.tenant_id, customer_id: cust.id, entry_type: g.type || 'purchase',
      status: 'draft', source: 'manual', upload_path: pdfPath, upload_name: g.name, upload_mime: 'application/pdf',
    }),
  });
  const [ins] = await insR.json();
  await fetch(`${URL}/rest/v1/bill_entry_lines`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ tenant_id: cust.tenant_id, entry_id: ins.id, line_no: 1, vat_type: 'vat', amount: 0, vat_amount: 0, wht_rate: 0, wht_amount: 0, ai_filled: false }),
  });
  out.push({ entryId: ins.id, name: g.name });
  console.log(`  ✓ entry ใหม่ ${ins.id}`);
}
if (!DRY_RUN) {
  const f = '/private/tmp/claude-501/-Users-momie-Desktop---------ai-nova-cx/0cee41f0-212e-446e-9577-e833376992b9/scratchpad/backfill-entries.json';
  writeFileSync(f, JSON.stringify({ tenantId: cust.tenant_id, entries: out }, null, 2));
  console.log('เขียนรายการ entry →', f);
}
