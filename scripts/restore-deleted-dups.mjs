// Restore the 10 soft-deleted duplicate customers
// DRY_RUN=false node scripts/restore-deleted-dups.mjs
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

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function query(table, params = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers });
  if (!r.ok) throw new Error(`GET ${r.status} ${await r.text()}`);
  return r.json();
}
async function patch(table, params, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH', headers, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${r.status} ${await r.text()}`);
  return r.json();
}

// รหัสที่ต้อง un-delete
const CODES = ['P811','P808','P806','P804','P790','P782','P778','P768','P763','P761'];

console.log(`\n${'='.repeat(60)}`);
console.log(`  Restore Deleted Customers — ${DRY_RUN ? '🔍 DRY RUN' : '⚡ LIVE'}`);
console.log(`${'='.repeat(60)}\n`);

let restored = 0;
for (const code of CODES) {
  // หาลูกค้าที่ถูก soft-delete (deleted_at IS NOT null)
  const rows = await query('customers',
    `customer_code=eq.${code}&deleted_at=not.is.null&select=id,name,deleted_at`);

  if (!rows.length) {
    console.log(`  ${code}: skip (not found or already active)`);
    continue;
  }

  const c = rows[0];
  if (DRY_RUN) {
    console.log(`  ${code}: [DRY] would restore — ${c.name} (deleted ${c.deleted_at})`);
  } else {
    await patch('customers', `id=eq.${c.id}`, { deleted_at: null, status: 'active' });
    console.log(`  ${code}: ✓ restored — ${c.name}`);
  }
  restored++;
}

if (!DRY_RUN) {
  console.log('\n── Verification ──');
  for (const code of CODES) {
    const rows = await query('customers',
      `customer_code=eq.${code}&deleted_at=is.null&select=id,name`);
    console.log(`  ${code}: ${rows.length ? `✓ active — ${rows[0].name}` : '✗ not found'}`);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${DRY_RUN ? 'DRY RUN' : 'Done'}: ${restored} restored`);
if (DRY_RUN) console.log('  Run with DRY_RUN=false to execute');
console.log(`${'='.repeat(60)}\n`);
