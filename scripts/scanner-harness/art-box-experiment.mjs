// Art-box alignment experiment (Phase 3, WP3.2): how far is the hash of a
// warped card from the reference hash of the printing the page identified,
// depending on where the art box is placed on the warp?
//
//   npx tsx scripts/scanner-harness/art-box-experiment.mjs --out DIR [--mode multiple|single] photo.jpg ...
//
// 1) every photo runs through /scan (HARNESS_URL); each warped card (the
//    base-size crop shown in the result list) is saved as PNG together with
//    the printing the page settled on (skipped when DIR already holds them);
// 2) every warp is hashed with the art box shrunk towards the centre by a
//    margin (0 = the reference box as it is, i.e. the warp taken for the
//    card image); each variant's Hamming distance to the reference hash in
//    the DB is printed per card, with the mean and the ≤10 / ≤14-bit counts
//    per variant. The warp keeps ~3.45% of background around the detected
//    quad (5% corner expansion), so the box must move inwards by about that
//    much. Measured on 102 cards of the eight development photos (2026-09-16):
//    margin 0 → mean 12.3 bits, 51 cards within 10; 0.02 → 9.2 bits, 78
//    within 10; 0.0345 → 9.8 bits, 70 within 10 (`WARP_ART_MARGIN` = 0.02).
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { hashArtPixels, hammingDistance, ART_BOX } from '../../src/lib/scanner/phash.ts';

const args = process.argv.slice(2);
let outDir = 'art-box-experiment';
let mode = 'multiple';
const photos = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--out') outDir = args[++i];
	else if (args[i] === '--mode') mode = args[++i];
	else photos.push(args[i]);
}
mkdirSync(outDir, { recursive: true });
const HARNESS_URL = process.env.HARNESS_URL ?? 'http://localhost:5173';
const DB_PATH = process.env.MTG_DB_PATH ?? 'data/mtg.db';
const MARGINS = [0, 0.02, 0.025, 0.03, 0.0345, 0.04, 0.05];

// ---- 1) dump the warps ----
const metaPath = join(outDir, 'cards.json');
if (!existsSync(metaPath)) {
	const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
	const all = [];
	for (const file of photos) {
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		await page.goto(`${HARNESS_URL}/scan`, { waitUntil: 'networkidle' });
		await page.getByRole('button', { name: mode === 'single' ? 'Single card' : 'Multiple cards' }).click();
		await page.setInputFiles('input[type=file]', file);
		await page.waitForFunction(() => /Scan complete:|No cards detected|Error:/.test(document.querySelector('pre')?.textContent ?? ''), null, { timeout: 600000 });
		const cards = await page.evaluate(() => Array.from(document.querySelectorAll('h3')).filter((h) => /^Card \d+/.test(h.innerText.trim())).map((h) => {
			const block = h.closest('.rounded-lg');
			const chosen = block.querySelector('.ring-1 p.font-semibold, p.font-semibold');
			const printing = chosen ? (chosen.nextElementSibling?.innerText.trim() ?? '') : '';
			const crop = block.querySelector('img')?.getAttribute('src') ?? null;
			return { card: h.innerText.trim().split('\n')[0].replace(/\s+/g, ' '), name: chosen ? chosen.innerText.trim() : null, printing, state: block.dataset.state ?? '', crop };
		}));
		const tag = basename(file).replace(/[^A-Za-z0-9_.-]/g, '_');
		cards.forEach((c, i) => {
			const png = `${tag}-card-${String(i + 1).padStart(2, '0')}.png`;
			if (c.crop) writeFileSync(join(outDir, png), Buffer.from(c.crop.split(',')[1], 'base64'));
			all.push({ file: basename(file), card: c.card, name: c.name, printing: c.printing, state: c.state, png: c.crop ? png : null });
		});
		console.log(`dumped ${cards.length} warps of ${basename(file)}`);
		await page.close();
	}
	await browser.close();
	writeFileSync(metaPath, JSON.stringify(all, null, 2));
}
const cards = JSON.parse(readFileSync(metaPath, 'utf8'));

// ---- 2) hash variants ----
const db = new Database(DB_PATH, { readonly: true });
const rowBySetNumber = db.prepare(`SELECT id, name, art_hash FROM cards WHERE set_code = ? AND collector_number = ?`);

function boxWithMargin(m) {
	return { x: m + ART_BOX.x * (1 - 2 * m), y: m + ART_BOX.y * (1 - 2 * m), w: ART_BOX.w * (1 - 2 * m), h: ART_BOX.h * (1 - 2 * m) };
}
async function rgbaOf(bytes) {
	const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
}
/** Hash of a pixel box (x, y, w, h in pixels) of an RGBA image. */
function hashBox(img, box) {
	const x = Math.max(0, Math.round(box.x)), y = Math.max(0, Math.round(box.y));
	const w = Math.max(1, Math.min(img.w - x, Math.round(box.w))), h = Math.max(1, Math.min(img.h - y, Math.round(box.h)));
	const out = new Uint8ClampedArray(w * h * 4);
	for (let r = 0; r < h; r++) out.set(img.data.subarray(((y + r) * img.w + x) * 4, ((y + r) * img.w + x + w) * 4), r * w * 4);
	return hashArtPixels(out, w, h, 4);
}
const relBox = (b, W, H) => ({ x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H });

const sums = new Map();
const add = (k, d) => {
	const s = sums.get(k) ?? { n: 0, sum: 0, le10: 0, le14: 0 };
	s.n++;
	s.sum += d;
	if (d <= 10) s.le10++;
	if (d <= 14) s.le14++;
	sums.set(k, s);
};
console.log(`card                                   ${MARGINS.map((m) => `m=${m}`.padEnd(8)).join('')}`);
for (const c of cards) {
	if (!c.png || !c.printing) continue;
	const m = /\(([A-Z0-9]+)\)\s*#(\S+)/.exec(c.printing);
	if (!m) continue;
	const row = rowBySetNumber.get(m[1].toLowerCase(), m[2]);
	if (!row) {
		console.log(`${c.card} ${c.name}: not in DB`);
		continue;
	}
	const warp = await rgbaOf(readFileSync(join(outDir, c.png)));
	const dists = [];
	for (const mg of MARGINS) {
		const d = row.art_hash && row.art_hash.length === 16 ? hammingDistance(hashBox(warp, relBox(boxWithMargin(mg), warp.w, warp.h)), row.art_hash) : NaN;
		dists.push(d);
		if (!Number.isNaN(d)) add(`m=${mg}`, d);
	}
	console.log(`${(c.name ?? '?').slice(0, 38).padEnd(39)}${dists.map((d) => String(d).padEnd(8)).join('')}`);
}
console.log('\nvariant     n   mean   <=10  <=14');
for (const [k, s] of sums) console.log(`${k.padEnd(10)} ${String(s.n).padStart(3)}  ${(s.sum / s.n).toFixed(1).padStart(5)}   ${String(s.le10).padStart(3)}   ${String(s.le14).padStart(3)}`);

// ---- 3) the other printings of the same name: can the artwork narrow the printing? ----
// For every card, the distance (margin WARP_ART_MARGIN) to every hashed printing of the
// name the page settled on, nearest first. Same-artwork reprints and variants should
// sit close to the scanned printing, different artwork far away.
if (args.includes('--printings')) {
	const { WARP_ART_MARGIN } = await import('../../src/lib/scanner/phash.ts');
	const printingsOf = db.prepare(`SELECT set_code, collector_number, art_hash FROM cards WHERE name = ? AND art_hash IS NOT NULL AND length(art_hash) = 16 AND layout <> 'art_series'`);
	console.log(`\nprintings of the identified name by distance (margin ${WARP_ART_MARGIN}); * = the printing the page chose`);
	for (const c of cards) {
		if (!c.png || !c.name) continue;
		const rows = printingsOf.all(c.name);
		if (rows.length < 2) continue;
		const warp = await rgbaOf(readFileSync(join(outDir, c.png)));
		const hash = hashBox(warp, relBox(boxWithMargin(WARP_ART_MARGIN), warp.w, warp.h));
		const m = /\(([A-Z0-9]+)\)\s*#(\S+)/.exec(c.printing ?? '');
		const chosen = m ? `${m[1].toLowerCase()}#${m[2]}` : '';
		const list = rows.map((r) => ({ key: `${r.set_code}#${r.collector_number}`, d: hammingDistance(hash, r.art_hash) })).sort((a, b) => a.d - b.d);
		console.log(`${c.name.slice(0, 30).padEnd(31)}${list.map((x) => `${x.key}:${x.d}${x.key === chosen ? '*' : ''}`).join('  ')}`);
	}
}
