// เปิดลูกค้ารายที่ 2 ของกลุ่มพามี: "บริษัท เจริญดี การบัญชี จำกัด" + ผูกผู้ดูแล = พี่สวย
//   เลขภาษี/ที่อยู่ อ่านจากใบแจ้งหนี้จริง (ผู้ออก) ที่ผู้ใช้ส่งมา
// DRY_RUN=false node scripts/create-charoendee-customer.mjs
import { readFileSync } from 'node:fs';
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

const TENANT = '11111111-1111-1111-1111-111111111111';
const SUAY = '36190885-24ae-4503-88e7-49638f3b1eb4'; // สมสวย (สวย)
const NAME = 'บริษัท เจริญดี การบัญชี จำกัด';
const CODE = 'N219';
const TAX_ID = '0735568005099'; // จากใบแจ้งหนี้ (ผู้ออก)
const ADDRESS = '62/47 หมู่ที่ 2 ต.สนามจันทร์ อ.เมืองนครปฐม จ.นครปฐม';

console.log(`\n${'='.repeat(60)}`);
console.log(`  เปิดลูกค้าใหม่ "${NAME}" — ${DRY_RUN ? '🔍 DRY RUN' : '⚡ LIVE'}`);
console.log(`${'='.repeat(60)}\n`);

const dupName = await q('customers', `name=eq.${encodeURIComponent(NAME)}&deleted_at=is.null&select=id,customer_code`);
if (dupName.length) { console.log(`  ⚠ มีชื่อนี้แล้ว: ${JSON.stringify(dupName)} — ยกเลิก`); process.exit(1); }
const dupCode = await q('customers', `customer_code=eq.${CODE}&deleted_at=is.null&select=id,name`);
if (dupCode.length) { console.log(`  ⚠ รหัส ${CODE} ถูกใช้แล้ว: ${JSON.stringify(dupCode)} — ยกเลิก`); process.exit(1); }
const dupTax = await q('customers', `tax_id=eq.${TAX_ID}&deleted_at=is.null&select=id,name,customer_code`);
if (dupTax.length) { console.log(`  ⚠ เลขภาษีนี้มีอยู่แล้ว: ${JSON.stringify(dupTax)} — ยกเลิก`); process.exit(1); }

if (DRY_RUN) {
  console.log(`  [DRY] insert customers: ${NAME} (${CODE}, company, tax=${TAX_ID})`);
  console.log(`  [DRY] insert chat_groups: manual → ผู้ดูแล=สวย`);
  console.log('\n  Run with DRY_RUN=false to execute\n');
  process.exit(0);
}

const [cust] = await ins('customers', {
  tenant_id: TENANT,
  name: NAME,
  customer_code: CODE,
  status: 'active',
  customer_type: 'company',
  tax_id: TAX_ID,
  address: ADDRESS,
});
console.log(`  ✓ customers: ${cust.id} (${CODE}, company, tax=${TAX_ID})`);

const [grp] = await ins('chat_groups', {
  tenant_id: TENANT,
  customer_id: cust.id,
  provider: 'manual',
  group_ref: `manual:${cust.id}`,
  group_kind: 'group',
  responsible_employee_id: SUAY,
  is_active: true,
});
console.log(`  ✓ chat_groups: ${grp.id} (manual, ผู้ดูแล=สวย)`);

const scope = await q('chat_groups', `responsible_employee_id=eq.${SUAY}&deleted_at=is.null&select=customer_id`);
console.log(`  ✓ สโคปพี่สวยตอนนี้: ${scope.length} ลูกค้า`);
console.log(`\n${'='.repeat(60)}\n  Done\n${'='.repeat(60)}\n`);
