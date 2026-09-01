// เปิดลูกค้ากลุ่มพามีเพิ่ม 4 ราย + ผูกผู้ดูแล = พี่สวย (บิลกระดาษ — กลุ่ม manual + ตั้งชื่อกลุ่ม)
//   ข้อมูลชื่อ/เลขภาษี อ่านจากเอกสารจริงที่ผู้ใช้ส่งมา (หนังสือรับรองหักฯ / ใบเสร็จสรรพากร / ตารางรายชื่อ)
// DRY_RUN=false node scripts/create-pamee-group-customers.mjs
import { readFileSync } from 'node:fs';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
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
const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function q(t, p) {
  const r = await fetch(`${URL}/rest/v1/${t}?${p}`, { headers });
  if (!r.ok) throw new Error(`GET ${t} ${r.status} ${await r.text()}`);
  return r.json();
}
async function ins(t, body) {
  const r = await fetch(`${URL}/rest/v1/${t}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${t} ${r.status} ${await r.text()}`);
  return r.json();
}

// เข้ารหัสชื่อกลุ่ม (ฟอร์แมตเดียวกับ lib/crypto/field.ts — v1 AES-256-GCM)
const encKey = scryptSync(env.CREDENTIAL_ENC_KEY, 'nova-cx.field.v1', 32);
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (t) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return 'v1:' + b64u(iv) + '.' + b64u(c.getAuthTag()) + '.' + b64u(ct);
};

const TENANT = '11111111-1111-1111-1111-111111111111';
const SUAY = '36190885-24ae-4503-88e7-49638f3b1eb4'; // สมสวย (สวย)

const CUSTOMERS = [
  { code: 'N220', name: 'บริษัท วรรณวนัช เบเกอรี่ จำกัด', tax: '0735562002462', address: '189 หมู่ 4 ต.ดอนข่อย อ.กำแพงแสน จ.นครปฐม 73140' },
  { code: 'N221', name: 'บริษัท พามี แท็กซ์ จำกัด', tax: '0135569008470', address: null },
  { code: 'N222', name: 'บริษัท พามีคอนซัลท์ จำกัด', tax: '0735568009965', address: null },
  { code: 'N223', name: 'บริษัท พามีกรุ๊ปการบัญชี จำกัด', tax: '0135568030471', address: null },
];

console.log(`\n${'='.repeat(64)}`);
console.log(`  เปิดลูกค้ากลุ่มพามี 4 ราย (ผู้ดูแล: สวย) — ${DRY_RUN ? '🔍 DRY RUN' : '⚡ LIVE'}`);
console.log(`${'='.repeat(64)}\n`);

for (const c of CUSTOMERS) {
  // กันซ้ำ: เลขภาษี / รหัส / ชื่อ
  const dupTax = await q('customers', `tax_id=eq.${c.tax}&deleted_at=is.null&select=customer_code,name`);
  if (dupTax.length) { console.log(`  ⚠ ${c.name}: เลขภาษีซ้ำกับ ${JSON.stringify(dupTax[0])} — ข้าม`); continue; }
  const dupCode = await q('customers', `customer_code=eq.${c.code}&deleted_at=is.null&select=name`);
  if (dupCode.length) { console.log(`  ⚠ ${c.code} ถูกใช้แล้ว (${dupCode[0].name}) — ข้าม`); continue; }
  const dupName = await q('customers', `name=eq.${encodeURIComponent(c.name)}&deleted_at=is.null&select=customer_code`);
  if (dupName.length) { console.log(`  ⚠ ${c.name}: ชื่อซ้ำ (${dupName[0].customer_code}) — ข้าม`); continue; }

  if (DRY_RUN) {
    console.log(`  [DRY] ${c.code} ${c.name} (tax ${c.tax})`);
    continue;
  }

  const [cust] = await ins('customers', {
    tenant_id: TENANT,
    name: c.name,
    customer_code: c.code,
    status: 'active',
    customer_type: 'company',
    tax_id: c.tax,
    ...(c.address ? { address: c.address } : {}),
  });
  const [grp] = await ins('chat_groups', {
    tenant_id: TENANT,
    customer_id: cust.id,
    provider: 'manual',
    group_ref: `manual:${cust.id}`,
    group_kind: 'group',
    responsible_employee_id: SUAY,
    is_active: true,
    display_name_enc: enc(`บิลกระดาษ · ${c.name} (${c.code})`),
  });
  console.log(`  ✓ ${c.code} ${c.name} → customer ${cust.id.slice(0, 8)} + group ${grp.id.slice(0, 8)}`);
}

// สรุปสโคปพี่สวย
const scope = await q('chat_groups', `responsible_employee_id=eq.${SUAY}&deleted_at=is.null&select=customer_id`);
const ids = scope.map((g) => g.customer_id).filter(Boolean);
const cust = ids.length ? await q('customers', `id=in.(${ids.join(',')})&deleted_at=is.null&select=customer_code,name&order=customer_code`) : [];
console.log(`\n  สโคปพี่สวยตอนนี้ (${cust.length} ราย):`);
for (const x of cust) console.log(`   - ${x.customer_code} ${x.name}`);
if (DRY_RUN) console.log('\n  Run with DRY_RUN=false to execute');
console.log(`\n${'='.repeat(64)}\n`);
