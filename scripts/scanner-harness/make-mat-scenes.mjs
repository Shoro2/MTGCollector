// Synthetic live frames with ground truth: real card images (Scryfall PNGs,
// transparent rounded corners) composited onto a real play-mat texture cut from
// a photo, plus plain light and plain black backgrounds. The live detector is
// measured on them with live-detect-experiment.mjs --truth DIR/scenes.json.
//
//   node scripts/scanner-harness/make-mat-scenes.mjs --out DIR --mat photo-with-mat.jpg [--mat-region x,y,w,h] [--mat-scale 0.36]
//
// Why: a phone session (2026-09-17) on a dark woven mat tracked the art box, a
// text box and patches of the mat instead of the card, and two photos are not
// a measurement. The card images are fetched once (120 ms apart) into
// DIR/cards/ and reused.
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
let outDir = 'mat-scenes', matPhoto = null, matRegion = null, matScale = 0.36;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--out') outDir = args[++i];
	else if (args[i] === '--mat') matPhoto = args[++i];
	else if (args[i] === '--mat-region') matRegion = args[++i].split(',').map(Number);
	else if (args[i] === '--mat-scale') matScale = Number(args[++i]);
}
if (!matPhoto) throw new Error('--mat <photo> is required');
mkdirSync(join(outDir, 'cards'), { recursive: true });
const SIZE = 1080; // the phone delivered a 1080x1080 stream

// ---- cards: a fixed, varied sample (every colour, extra black frames, colourless, multicolour) ----
const db = new Database(process.env.MTG_DB_PATH ?? 'data/mtg.db', { readonly: true });
const pick = (colors, n) => db.prepare(`SELECT id, name, set_code, collector_number, colors, type_line, image_uri FROM cards
	WHERE layout = 'normal' AND released_at >= '2019-01-01' AND released_at < '2026-01-01' AND colors = ? AND image_uri LIKE '%/normal/%'
	AND set_code IN ('m20','eld','thb','iko','znr','khm','stx','afr','mid','vow','neo','snc','dmu','bro','one','mom','woe','lci','mkm','otj','blb','dsk','fdn')
	ORDER BY id LIMIT ? OFFSET 40`).all(colors, n);
const cards = [...pick('["W"]', 5), ...pick('["U"]', 5), ...pick('["B"]', 10), ...pick('["R"]', 5), ...pick('["G"]', 5), ...pick('[]', 5), ...pick('["G","U"]', 2), ...pick('["R","W"]', 1)];
let last = 0;
for (const c of cards) {
	c.png = join(outDir, 'cards', `${c.id}.png`);
	if (existsSync(c.png)) continue;
	const wait = 120 - (Date.now() - last);
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	last = Date.now();
	const url = c.image_uri.replace('/normal/', '/png/').replace('.jpg', '.png');
	const res = await fetch(url, { headers: { 'User-Agent': 'MTGCollector/1.0 (scanner test scenes; github.com/Shoro2/MTGCollector)', Accept: 'image/*' } });
	if (!res.ok) { console.log('skip', c.name, res.status); c.png = null; continue; }
	writeFileSync(c.png, Buffer.from(await res.arrayBuffer()));
}
const usable = cards.filter((c) => c.png);
console.log(`${usable.length} card images`);

// ---- backgrounds ----
const matMeta = await sharp(matPhoto).rotate().metadata();
const MW = matMeta.autoOrient?.width ?? matMeta.width, MH = matMeta.autoOrient?.height ?? matMeta.height;
const [rx, ry, rw, rh] = matRegion ?? [Math.round(MW * 0.04), Math.round(MH * 0.84), Math.round(MW * 0.92), Math.round(MH * 0.15)];
const tileW = Math.round(rw * matScale), tileH = Math.round(rh * matScale);
const tile = await sharp(matPhoto).rotate().extract({ left: rx, top: ry, width: rw, height: rh }).resize(tileW, tileH).toBuffer();
const tiles = { '00': tile, '10': await sharp(tile).flop().toBuffer(), '01': await sharp(tile).flip().toBuffer(), '11': await sharp(tile).flip().flop().toBuffer() };
const layers = [];
for (let y = 0, j = 0; y < SIZE; y += tileH, j++) for (let x = 0, i = 0; x < SIZE; x += tileW, i++) layers.push({ input: tiles[`${i % 2}${j % 2}`], left: x, top: y });
const canvas = (color) => sharp({ create: { width: SIZE + tileW, height: SIZE + tileH, channels: 3, background: color } });
const matBg = await canvas('#222').composite(layers).extract({ left: 0, top: 0, width: SIZE, height: SIZE }).png().toBuffer();
const noise = (base, amp, seed) => {
	const buf = Buffer.alloc(SIZE * SIZE * 3);
	let s = seed;
	for (let i = 0; i < buf.length; i += 3) {
		s = (s * 1664525 + 1013904223) >>> 0;
		const n = ((s >>> 24) / 255 - 0.5) * amp;
		buf[i] = Math.max(0, Math.min(255, base[0] + n)); buf[i + 1] = Math.max(0, Math.min(255, base[1] + n)); buf[i + 2] = Math.max(0, Math.min(255, base[2] + n));
	}
	return sharp(buf, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
};
const backgrounds = { mat: matBg, light: await noise([207, 201, 191], 14, 7), black: await noise([16, 16, 17], 10, 11) };

// ---- scenes ----
const scenes = [];
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 0xffffffff);
async function scene(card, background, pose, brightness) {
	const h = pose.h, w = Math.round(h * 745 / 1040);
	const angle = pose.base + (rnd() - 0.5) * 2 * pose.jitter;
	const cx = SIZE / 2 + (rnd() - 0.5) * 120, cy = SIZE / 2 + (rnd() - 0.5) * 120;
	const rotated = await sharp(card.png).resize(w, h).rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer({ resolveWithObject: true });
	const left = Math.round(cx - rotated.info.width / 2), top = Math.round(cy - rotated.info.height / 2);
	const a = (angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
	const ccx = left + rotated.info.width / 2, ccy = top + rotated.info.height / 2;
	const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [ccx + x * cos - y * sin, ccy + x * sin + y * cos]);
	const name = `${background}-${String(scenes.length + 1).padStart(3, '0')}.jpg`;
	await sharp(backgrounds[background]).composite([{ input: rotated.data, left, top }]).modulate({ brightness }).blur(0.9).jpeg({ quality: 85 }).toFile(join(outDir, name));
	scenes.push({ file: name, background, brightness, angle: Math.round(angle * 10) / 10, card: { name: card.name, set: card.set_code, number: card.collector_number, colors: card.colors }, corners });
}
const upright = { h: 820, base: 0, jitter: 7 }, sideways = { h: 760, base: 90, jitter: 6 }, far = { h: 560, base: 0, jitter: 10 };
for (const [i, c] of usable.entries()) {
	await scene(c, 'mat', upright, i % 2 ? 0.75 : 1);
	await scene(c, 'mat', i % 3 === 0 ? far : sideways, i % 2 ? 1 : 0.8);
}
for (const c of usable.filter((_, i) => i % 3 === 0)) await scene(c, 'light', upright, 1);
for (const c of usable.filter((_, i) => i % 3 === 1)) await scene(c, 'black', upright, 0.9);
writeFileSync(join(outDir, 'scenes.json'), JSON.stringify(scenes, null, 1));
console.log(`${scenes.length} scenes -> ${outDir}`);
