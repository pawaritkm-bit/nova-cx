// Delete duplicate customer codes that Nova Sale already deleted
// Step 1: move references (opportunity + invitation) to keep customer
// Step 2: soft-delete the duplicate customer
// DRY_RUN=false node scripts/delete-nova-sale-dups.mjs
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
  if (!r.ok) throw new Error(`GET ${table} ${r.status} ${await r.text()}`);
  return r.json();
}

async function patch(table, params, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const r = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PATCH ${table} ${r.status} ${await r.text()}`);
  return r.json();
}

// [ชื่อ, รหัสที่เก็บ(Nova Sale), รหัสซ้ำที่ต้องลบใน CX]
const DUPS = [
  ['เซอร์แมท พูลวิลล่า',   'P769', 'P811'],
  ['เกียรติก้อง เก้อทอง',   'P486', 'P808'],
  ['นภัสนันท์ แซ่ตั้น',     'P408', 'P806'],
  ['ภัสชรดา ยศปัญญา',      'P454', 'P804'],
  ['พิมพ์ชนก โซดิช่วง',     'P376', 'P790'],
  ['ธัญรัศม์ สุดโคต',       'P266', 'P782'],
  ['มาลัย วิภาณุรัตน์',     'P321', 'P778'],
  ['ณัฐพงค์ พลอยประดับ',    'P169', 'P768'],
  ['ปนัดดา เกตุชุนทด',      'P172', 'P763'],
  ['นภารัตน์ ภูบุญพา',      'P579', 'P761'],
];

const MOVE_TABLES = ['sales_opportunities', 'survey_invitations'];

const now = new Date().toISOString();

console.log(`\n${'='.repeat(70)}`);
console.log(`  Delete Nova Sale Duplicates — ${DRY_RUN ? '🔍 DRY RUN' : '⚡ LIVE'}`);
console.log(`${'='.repeat(70)}\n`);

let success = 0;
let skipped = 0;

for (const [name, keepCode, deleteCode] of DUPS) {
  console.log(`  ${name} — keep ${keepCode}, delete ${deleteCode}`);

  const keepRows = await query('customers',
    `customer_code=eq.${encodeURIComponent(keepCode)}&deleted_at=is.null&select=id`);
  const delRows = await query('customers',
    `customer_code=eq.${encodeURIComponent(deleteCode)}&deleted_at=is.null&select=id`);

  if (!keepRows.length) {
    console.log(`    ⚠ keep (${keepCode}) not found — skipping`);
    skipped++;
    continue;
  }
  if (!delRows.length) {
    console.log(`    skip (${deleteCode} not found or already deleted)`);
    skipped++;
    continue;
  }

  const keepId = keepRows[0].id;
  const delId = delRows[0].id;

  // Step 1: move references from duplicate → keep
  for (const table of MOVE_TABLES) {
    const refs = await query(table, `customer_id=eq.${delId}&select=id`);
    if (refs.length === 0) continue;

    if (DRY_RUN) {
      console.log(`    [DRY] would move ${refs.length} ${table} → ${keepCode}`);
    } else {
      await patch(table, `customer_id=eq.${delId}`, { customer_id: keepId });
      console.log(`    ✓ moved ${refs.length} ${table} → ${keepCode}`);
    }
  }

  // Step 2: soft-delete duplicate customer
  if (DRY_RUN) {
    console.log(`    [DRY] would soft-delete ${deleteCode} (id=${delId})`);
  } else {
    await patch('customers', `id=eq.${delId}`, { deleted_at: now });
    console.log(`    ✓ soft-deleted ${deleteCode}`);
  }
  success++;
}

// Verification
if (!DRY_RUN) {
  console.log('\n── Verification ──');
  for (const [name, keepCode, deleteCode] of DUPS) {
    const keep = await query('customers',
      `customer_code=eq.${encodeURIComponent(keepCode)}&deleted_at=is.null&select=id`);
    const del = await query('customers',
      `customer_code=eq.${encodeURIComponent(deleteCode)}&deleted_at=is.null&select=id`);
    const status = keep.length && !del.length ? '✓' : '⚠';
    console.log(`  ${status} ${keepCode} ${keep.length ? 'active' : 'MISSING'}  |  ${deleteCode} ${del.length ? 'STILL ACTIVE!' : 'deleted'}`);
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  ${DRY_RUN ? 'DRY RUN' : 'Done'}: ${success} processed, ${skipped} skipped`);
if (DRY_RUN) console.log('  Run with DRY_RUN=false to execute');
console.log(`${'='.repeat(70)}\n`);
