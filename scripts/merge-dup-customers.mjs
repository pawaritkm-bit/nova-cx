// Merge/delete duplicate customers — run with: node scripts/merge-dup-customers.mjs
// DRY_RUN=false node scripts/merge-dup-customers.mjs  ← to execute for real
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
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SERVICE_ROLE_KEY');
  process.exit(1);
}

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function query(table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function patch(table, params, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const r = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PATCH ${table} ${r.status} ${await r.text()}`);
  return r.json();
}

async function findCustomer(code) {
  return query('customers', `customer_code=eq.${encodeURIComponent(code)}&deleted_at=is.null`);
}

const now = new Date().toISOString();

console.log(`\n${'='.repeat(60)}`);
console.log(`  Duplicate Customer Cleanup — ${DRY_RUN ? '🔍 DRY RUN' : '⚡ LIVE'}`);
console.log(`${'='.repeat(60)}\n`);

// ────────────────────────────────────────────────────────────
// Case 1: ณัชชา ยวงงิ้วราย — เก็บ P724, soft-delete P611
// ────────────────────────────────────────────────────────────
console.log('── Case 1: ณัชชา ยวงงิ้วราย — soft-delete P611 ──');
const p611 = await findCustomer('P611');

if (!p611.length) {
  console.log('  P611 not found (already deleted?) — skipping');
} else {
  console.log(`  P611: id=${p611[0].id}, name="${p611[0].name}"`);
  if (DRY_RUN) {
    console.log('  → [DRY] would soft-delete P611');
  } else {
    await patch('customers', `id=eq.${p611[0].id}`, { deleted_at: now });
    console.log('  ✓ P611 soft-deleted');
  }
}

// ────────────────────────────────────────────────────────────
// Case 2: บอนนาน่า เฮาส์ — soft-delete N193 (ว่าง), แก้รหัส ์N193 → N193
// ────────────────────────────────────────────────────────────
console.log('\n── Case 2: บอนนาน่า เฮาส์ — ลบ N193 ว่าง, แก้รหัส ์N193 → N193 ──');
const n193 = await findCustomer('N193');
const n193bad = await findCustomer('์N193');

if (!n193.length) {
  console.log('  N193 (ว่าง) not found — skipping delete');
} else {
  console.log(`  N193 (ว่าง): id=${n193[0].id}`);
  if (DRY_RUN) {
    console.log('  → [DRY] would soft-delete N193 (ว่าง)');
  } else {
    await patch('customers', `id=eq.${n193[0].id}`, { deleted_at: now });
    console.log('  ✓ N193 (ว่าง) soft-deleted');
  }
}

if (!n193bad.length) {
  console.log('  ์N193 not found — skipping rename');
} else {
  console.log(`  ์N193 (มีข้อมูล): id=${n193bad[0].id}`);
  if (DRY_RUN) {
    console.log('  → [DRY] would rename customer_code ์N193 → N193');
  } else {
    // ต้อง soft-delete N193 ก่อน (ข้างบน) ไม่งั้น unique constraint ชน
    await patch('customers', `id=eq.${n193bad[0].id}`, { customer_code: 'N193' });
    console.log('  ✓ ์N193 renamed to N193');
  }
}

// ────────────────────────────────────────────────────────────
// Verify
// ────────────────────────────────────────────────────────────
if (!DRY_RUN) {
  console.log('\n── Verification ──');
  const checkP724 = await findCustomer('P724');
  const checkP611 = await findCustomer('P611');
  const checkN193 = await findCustomer('N193');
  const checkN193bad = await findCustomer('์N193');
  console.log(`  P724: ${checkP724.length ? '✓ active' : '✗ not found'}`);
  console.log(`  P611: ${checkP611.length ? '⚠ still active!' : '✓ deleted'}`);
  console.log(`  N193: ${checkN193.length ? `✓ active — id=${checkN193[0].id}` : '✗ not found'}`);
  console.log(`  ์N193: ${checkN193bad.length ? '⚠ still exists!' : '✓ gone'}`);
}

console.log(`\n${'='.repeat(60)}`);
console.log(DRY_RUN
  ? '  DRY RUN — run with DRY_RUN=false to execute'
  : '  Done!');
console.log(`${'='.repeat(60)}\n`);
