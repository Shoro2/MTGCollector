// Build first. Scanner API regression against a new synthetic database, never the app DB.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../src/lib/server/schema-sql.ts';

const dir = resolve('data', `scanner-catalogue-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const path = resolve(dir, 'mtg.db'), db = new Database(path);
db.exec(SCHEMA_SQL);
db.exec('ALTER TABLE cards ADD COLUMN art_hash TEXT');
const insert = db.prepare(`INSERT INTO cards (id, name, layout, set_code, collector_number, rarity, is_paper, art_hash)
 VALUES (?, ?, ?, 'tst', ?, 'rare', ?, ?)`);
for (let i = 0; i < 20; i++) insert.run(`a${i}`, 'Paper Example', 'normal', String(i), 1, '000000000000000f');
insert.run('digital', 'Digital Example', 'normal', '90', 0, '0000000000000000');
insert.run('art', 'Art Example', 'art_series', '91', 1, '0000000000000000');
insert.run('unknown', 'Unknown Example', 'normal', '92', null, null);
insert.run('competitor', 'Competing Example', 'normal', '93', 1, '000000000000007f');
const port = Number(process.env.SCANNER_CATALOGUE_PORT || 5197), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['build/index.js'], { windowsHide: true,
 env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, MTG_DB_PATH: path, DISABLE_PRICE_UPDATES: '1' }, stdio: ['ignore','pipe','pipe'] });
let output = '';
server.stdout.on('data', data => output += data); server.stderr.on('data', data => output += data);
async function post(body) {
 const response = await fetch(origin + '/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
 assert.equal(response.status, 200); return response.json();
}
try {
 for (let i = 0; i < 100; i++) {
  if (server.exitCode !== null) throw new Error(output);
  try { if ((await fetch(origin + '/api/health')).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 100));
 }
 const prints = (await post({printings:['Paper Example','Digital Example','Art Example','Unknown Example']})).batch;
 assert.deepEqual(prints.map(p => p.results.length), [20, 0, 0, 1]);
 console.log('PASS paper printings and unknown availability remain; digital and art-series are excluded');
 const exact = (await post({queries:['Digital Example','Art Example','Unknown Example','Paper Examp'],exactOnly:true})).batch;
 assert.deepEqual(exact.map(p => p.results.length), [0,0,1,0]);
 const fuzzy = (await post({queries:['Paper Examp','Digital Examp']})).batch;
 assert.ok(fuzzy[0].results.some(r => r.name === 'Paper Example'));
 assert.ok(fuzzy.every(q => q.results.every(r => r.id !== 'digital' && r.id !== 'art')));
 console.log('PASS exact-only orientation lookup skips fuzzy work; normal OCR search still supports it');
 const lookups = (await post({lookups:[{setCode:'tst',collectorNumber:'90'},{setCode:'tst',collectorNumber:'91'}]})).batch;
 assert.ok(lookups.every(q => q.results.length === 0));
 const near = (await post({near:[{setCode:'tst',collectorNumber:'99',rarity:'r'}]})).batch[0].results;
 assert.ok(near.every(r => r.id !== 'digital' && r.id !== 'art'));
 const art = (await post({artHashes:[{hash:'0000000000000000'}]})).batch[0].matches;
 assert.ok(art.length > 0 && art.every(m => m.row.id !== 'digital' && m.row.id !== 'art'));
 console.log('PASS footer, near-number and artwork paths exclude digital/art-series candidates');
 const probe = {artHashes:[{hash:'0000000000000000'}],identityProbe:true};
 assert.equal((await post(probe)).batch[0].identity, null);
 console.log('PASS twenty close reprints cannot hide a competing identity from a replacement probe');
 db.prepare('UPDATE cards SET is_paper=0 WHERE id=?').run('competitor');
 assert.equal((await post(probe)).batch[0].identity, 'Paper Example');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n, 24);
 console.log('PASS artwork index refreshes after metadata changes; catalogue rows remain intact');
} finally { db.close(); server.kill(); }
