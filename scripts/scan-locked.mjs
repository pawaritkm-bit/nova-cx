// Live MS Graph scan: check retry-locked backlog state across OneDrive statement folders.
// Read-only. Loads creds from nova-cx/.env.local.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const envPath = path.join(os.homedir(), 'Desktop', 'โปรแกรม ai', 'nova-cx', '.env.local');
const env = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}
const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, ONEDRIVE_USER } = env;

async function token() {
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token fail: ' + JSON.stringify(j));
  return j.access_token;
}

const G = 'https://graph.microsoft.com/v1.0';
let TOK;
async function graph(url) {
  const r = await fetch(url.startsWith('http') ? url : G + url, {
    headers: { Authorization: `Bearer ${TOK}` },
  });
  if (!r.ok) throw new Error(`${r.status} ${url} ${await r.text()}`);
  return r.json();
}

// drive id for the ONEDRIVE_USER
async function driveId() {
  const j = await graph(`/users/${ONEDRIVE_USER}/drive`);
  return j.id;
}

// recursively walk, collect all item names + paths
async function walk(driveId, itemId, prefix, out) {
  let url = `/drives/${driveId}/items/${itemId}/children?$top=200&$select=name,folder,file,id`;
  while (url) {
    const j = await graph(url);
    for (const it of j.value) {
      const p = prefix + '/' + it.name;
      out.push({ name: it.name, path: p, isFolder: !!it.folder });
      if (it.folder) await walk(driveId, it.id, p, out);
    }
    url = j['@odata.nextLink'] || null;
  }
}

async function rootByName(driveId, name) {
  const j = await graph(`/drives/${driveId}/root/children?$select=name,id,folder&$top=200`);
  return j.value.find((v) => v.name === name);
}

(async () => {
  TOK = await token();
  const dId = await driveId();
  const roots = ['NOVA-Bills', 'NOVA-Care'];
  const all = [];
  for (const rn of roots) {
    const r = await rootByName(dId, rn);
    if (!r) { console.log(`(root missing: ${rn})`); continue; }
    await walk(dId, r.id, '/' + rn, all);
  }
  const lockedNotes = all.filter((x) => !x.isFolder && x.name.includes('ใส่รหัสที่นี่'));
  const summaries = all.filter((x) => !x.isFolder && x.name.includes('สรุป') && x.name.toLowerCase().endsWith('.csv'));
  const okOriginals = all.filter((x) => !x.isFolder && x.name.includes('✅'));
  console.log('TOTAL_ITEMS', all.length);
  console.log('LOCKED_NOTES', lockedNotes.length);
  lockedNotes.forEach((x) => console.log('  🔑', x.path));
  console.log('SUMMARIES_CSV', summaries.length);
  summaries.forEach((x) => console.log('  📄', x.path));
  console.log('OK_ORIGINALS', okOriginals.length);
  okOriginals.forEach((x) => console.log('  ✅', x.path));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
