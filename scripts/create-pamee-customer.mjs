// เปิดลูกค้าใหม่ "สำนักงานบัญชีพามี" + ผูกผู้ดูแล = พี่สวย (บิลกระดาษ 100% — ไม่มีกลุ่มไลน์)
//   1) insert customers (N218)
//   2) insert chat_groups แบบ manual (provider='manual' ไม่ผูก LINE) เพื่อให้เข้าสโคปของพี่สวย
// DRY_RUN=false node scripts/create-pamee-customer.mjs
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
const SUAY = '36190885-24ae-4503-88e7-49638f3b1eb4'; // สมสวย (สวย) — accountant, active
const NAME = 'สำนักงานบัญชีพามี';
const CODE = 'N218';

console.log(`\n${'='.repeat(60)}`);
console.log(`  เปิดลูกค้าใหม่ "${NAME}" — ${DRY_RUN ? '🔍 DRY RUN' : '⚡ LIVE'}`);
console.log(`${'='.repeat(60)}\n`);

// กันซ้ำ: ชื่อ / รหัส
const dupName = await q('customers', `name=eq.${encodeURIComponent(NAME)}&deleted_at=is.null&select=id,customer_code`);
if (dupName.length) {
  console.log(`  ⚠ มีลูกค้าชื่อนี้อยู่แล้ว: ${JSON.stringify(dupName)} — ยกเลิก`);
  process.exit(1);
}
const dupCode = await q('customers', `customer_code=eq.${CODE}&deleted_at=is.null&select=id,name`);
if (dupCode.length) {
  console.log(`  ⚠ รหัส ${CODE} ถูกใช้แล้ว: ${JSON.stringify(dupCode)} — ยกเลิก`);
  process.exit(1);
}

// ยืนยันพนักงาน
const emp = await q('employees', `id=eq.${SUAY}&deleted_at=is.null&is_active=eq.true&select=id,nickname,first_name`);
if (!emp.length) {
  console.log('  ⚠ ไม่พบพนักงาน (สวย) ที่ active — ยกเลิก');
  process.exit(1);
}
console.log(`  ผู้ดูแล: ${emp[0].nickname} (${emp[0].first_name})`);

if (DRY_RUN) {
  console.log(`  [DRY] would insert customers: ${NAME} (${CODE}, active)`);
  console.log(`  [DRY] would insert chat_groups: provider=manual → ผูกลูกค้า + ผู้ดูแล=สวย`);
  console.log('\n  Run with DRY_RUN=false to execute\n');
  process.exit(0);
}

// 1) ลูกค้า
const [cust] = await ins('customers', {
  tenant_id: TENANT,
  name: NAME,
  customer_code: CODE,
  status: 'active',
});
console.log(`  ✓ customers: ${cust.id} (${CODE})`);

// 2) กลุ่ม placeholder (ไม่ใช่กลุ่มไลน์จริง) — ให้เข้าสโคปนักบัญชีของพี่สวย
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

// ตรวจกลับ
const check = await q('chat_groups', `customer_id=eq.${cust.id}&select=id,responsible_employee_id,provider&deleted_at=is.null`);
console.log(`  ✓ verify: ${JSON.stringify(check)}`);
console.log(`\n${'='.repeat(60)}\n  Done — พี่สวยล็อกอินแล้วจะเห็น "${NAME}" ในสโคปทันที\n${'='.repeat(60)}\n`);
