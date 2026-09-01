// เปิดธง auto_bills_from_statement ให้ลูกค้ากลุ่มพามี (N218-N223)
//   ใช้หลัง apply migration 0125 แล้ว — node scripts/enable-auto-bills-pamee.mjs
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const envPath = path.join(os.homedir(), 'Desktop', 'โปรแกรม ai', 'nova-cx', '.env.local');
const env = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}
const h = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};
const r = await fetch(
  env.NEXT_PUBLIC_SUPABASE_URL +
    '/rest/v1/customers?customer_code=in.(N218,N219,N220,N221,N222,N223)&deleted_at=is.null&select=customer_code,name,auto_bills_from_statement',
  { method: 'PATCH', headers: h, body: JSON.stringify({ auto_bills_from_statement: true }) }
);
if (!r.ok) {
  console.error('PATCH failed', r.status, await r.text());
  console.error('→ ถ้า error บอกไม่มีคอลัมน์ = ยังไม่ได้ apply migration 0125 (npx supabase db push)');
  process.exit(1);
}
const rows = await r.json();
console.log('เปิดธงแล้ว', rows.length, 'ราย:');
for (const c of rows) console.log('-', c.customer_code, c.name, '→', c.auto_bills_from_statement);
