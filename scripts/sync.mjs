// Sync dated EduScope HTML files (YYYY-MM-DD.html) from a public Google Drive folder.
// The newest date becomes site/index.html; every edition is kept in site/archive/.
import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.DRIVE_API_KEY;
const FOLDER = process.env.DRIVE_FOLDER_ID;
const DOMAIN = process.env.CUSTOM_DOMAIN || '';
if (!KEY || !FOLDER) throw new Error('DRIVE_API_KEY and DRIVE_FOLDER_ID are required');

const API = 'https://www.googleapis.com/drive/v3/files';
const SITE = 'site';
const ARCH = path.join(SITE, 'archive');
const MANIFEST = path.join(ARCH, 'manifest.json');
const DATED = /^\d{4}-\d{2}-\d{2}\.html$/;

await fs.mkdir(ARCH, { recursive: true });

async function readOrNull(p) { try { return await fs.readFile(p); } catch { return null; } }
async function writeIfChanged(p, buf) {
  const old = await readOrNull(p);
  if (old && old.equals(buf)) return false;
  await fs.writeFile(p, buf);
  return true;
}

let manifest = {};
const mRaw = await readOrNull(MANIFEST);
if (mRaw) manifest = JSON.parse(mRaw.toString('utf8'));

// 1) List the folder
const files = [];
let pageToken = '';
do {
  const u = new URL(API);
  u.searchParams.set('q', `'${FOLDER}' in parents and trashed=false`);
  u.searchParams.set('fields', 'nextPageToken,files(id,name,modifiedTime,size)');
  u.searchParams.set('pageSize', '1000');
  u.searchParams.set('key', KEY);
  if (pageToken) u.searchParams.set('pageToken', pageToken);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Drive list failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  files.push(...(j.files || []));
  pageToken = j.nextPageToken || '';
} while (pageToken);

const dated = files.filter(f => DATED.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
if (!dated.length) throw new Error('No YYYY-MM-DD.html files found in the Drive folder');

// 2) Download new or modified editions
let changed = false;
for (const f of dated) {
  const dest = path.join(ARCH, f.name);
  const m = manifest[f.name];
  const exists = (await readOrNull(dest)) !== null;
  if (exists && m && m.id === f.id && m.modifiedTime === f.modifiedTime) continue;
  const r = await fetch(`${API}/${f.id}?alt=media&key=${KEY}`);
  if (!r.ok) throw new Error(`Download failed for ${f.name}: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (await writeIfChanged(dest, buf)) { changed = true; console.log('updated', f.name); }
  manifest[f.name] = { id: f.id, modifiedTime: f.modifiedTime };
}

// 3) Latest edition -> index.html
const latest = dated.at(-1).name;
const latestBuf = await fs.readFile(path.join(ARCH, latest));
if (await writeIfChanged(path.join(SITE, 'index.html'), latestBuf)) changed = true;

// 4) Archive list page
const items = dated.map(f => f.name).reverse()
  .map(n => `    <li><a href="./${n}">${n.replace('.html', '')}</a></li>`).join('\n');
const archiveHtml = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EduScope Daily Brief - 지난 호</title>
<style>body{font-family:system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.7}a{color:#1a56db}</style>
</head><body>
  <h1>EduScope Daily Brief 지난 호</h1>
  <p><a href="/">최신호 보기</a></p>
  <ul>
${items}
  </ul>
</body></html>
`;
if (await writeIfChanged(path.join(ARCH, 'index.html'), Buffer.from(archiveHtml))) changed = true;

await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
if (DOMAIN) await fs.writeFile(path.join(SITE, 'CNAME'), DOMAIN + '\n');

console.log(`latest=${latest} changed=${changed}`);
if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nlatest=${latest.replace('.html', '')}\n`);
}
