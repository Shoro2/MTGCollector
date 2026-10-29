// Synthetic photos of overlapping card rows ("rows" scan mode) with ground truth.
//
//   node scripts/scanner-harness/make-overlap-scenes.mjs OUT_DIR [--only name,name] [--scale 0.5]
//   OPENCV_JS=/path/to/opencv.js node ... (needed for the scenes with perspective)
//
// Every scene lays out rows of fanned cards the way the /scan guide asks for:
// each card lies on top of the previous one, shifted to the right so that the
// left part of the card below stays visible (name start and the collector
// corner), the last card of a row is fully visible, the next row lies below
// without covering the row above. The cards are drawn like make-synthetic.mjs
// draws them, but with varied frames, procedural artwork (dark artworks
// included, because a dark card below hides the edge of the card on top),
// both collector-line formats (`146/249 C` + `M10 • EN` before 2023,
// `C 0156` + `TMT • EN` since) and a drop shadow. Names, sets and numbers come
// from seed-cards.json, so a harness server seeded with seed-test-db.mjs can
// identify them.
//
// Rows can be tilted, arced, unevenly spaced, rotated 90/180/270 degrees as a
// whole and seen in perspective; backgrounds are a light table, paper, a dark
// woven play mat and black cloth. OUT_DIR/overlap-scenes.json lists every card
// per scene: name, set, number, row, index in the row, its four corners in the
// photo (top-left, top-right, bottom-right, bottom-left of the upright card)
// and the visible fraction of its width (1 for the last card of a row).
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const outDir = args.find((a, i) => !a.startsWith('--') && !['--only', '--scale'].includes(args[i - 1])) ?? 'overlap-scenes';
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const scale = args.includes('--scale') ? Number(args[args.indexOf('--scale') + 1]) : 1;
mkdirSync(outDir, { recursive: true });

const seed = JSON.parse(readFileSync(new URL('./seed-cards.json', import.meta.url), 'utf8'))
	// a physical card shows the face name; double-faced records carry "Front // Back"
	.map((c) => ({ ...c, face: c.name.split(' // ')[0] }));

/**
 * Scene parameters. Lengths in pixels of the final photo (before --scale), angles in degrees.
 * d: spacing of the left edges as a fraction of the card width, dJitter its relative spread;
 * tilt: row direction; arc: rise of the row ends in card heights (positive = ends higher);
 * jitter: per-card rotation spread; rotate: rotation of the whole photo; perspective: corner
 * offsets as fractions of the photo size (keystone); rowGap: extra gap between rows in card
 * heights (negative: rows touch); rowCounts: cards per row instead of `n`; darkRatio: share of
 * very dark artworks (default 0.3); glare: [x, y, radius] of a lamp reflection as fractions of
 * the photo; dim: darkening of the whole photo (0-1); blur: camera blur in pixels.
 */
const scenes = [
	{ name: 'rows-light-2x12', w: 4000, h: 3000, bg: 'table', rows: 2, n: 12, H: 900, d: 0.34, dJitter: 0.06, tilt: 1.5, arc: 0, jitter: 1.2, seed: 11 },
	{ name: 'rows-darkmat-2x15', w: 4000, h: 3000, bg: 'darkmat', rows: 2, n: 15, H: 820, d: 0.31, dJitter: 0.12, tilt: -2.5, arc: 0.12, jitter: 2.2, seed: 12 },
	{ name: 'rows-arc-2x15', w: 4000, h: 3000, bg: 'paper', rows: 2, n: 15, H: 720, d: 0.32, dJitter: 0.1, tilt: 5, arc: 0.4, jitter: 2.5, seed: 13, rowGap: 0.3 },
	{ name: 'rows-rot180-2x12', w: 4000, h: 3000, bg: 'table', rows: 2, n: 12, H: 900, d: 0.34, dJitter: 0.06, tilt: -1, arc: 0.05, jitter: 1.2, seed: 14, rotate: 180 },
	{ name: 'rows-rot90-2x13', w: 4000, h: 3000, bg: 'darkmat', rows: 2, n: 13, H: 860, d: 0.32, dJitter: 0.1, tilt: 2, arc: -0.1, jitter: 1.8, seed: 15, rotate: 90 },
	{ name: 'rows-persp-2x14', w: 4000, h: 3000, bg: 'table', rows: 2, n: 14, H: 820, d: 0.32, dJitter: 0.08, tilt: 0.5, arc: 0.08, jitter: 1.5, seed: 16, perspective: [[0.05, 0.04], [-0.03, 0.0], [0.02, -0.02], [-0.06, -0.05]], blur: 1.2 },
	{ name: 'rows-black-3x10', w: 4000, h: 3000, bg: 'black', rows: 3, n: 10, H: 760, d: 0.27, dJitter: 0.08, tilt: -1, arc: 0, jitter: 1.5, seed: 17 },
	{ name: 'rows-wide-1x8', w: 4000, h: 3000, bg: 'table', rows: 1, n: 8, H: 1150, d: 0.45, dJitter: 0.1, tilt: 3, arc: 0, jitter: 2, seed: 18 },
	{ name: 'rows-tight-3x15', w: 4000, h: 3000, bg: 'paper', rows: 3, n: 15, H: 640, d: 0.22, dJitter: 0.1, tilt: -2, arc: 0.1, jitter: 2, seed: 21 },
	{ name: 'rows-dim-darkmat-2x15', w: 3000, h: 2250, bg: 'darkmat', rows: 2, n: 15, H: 600, d: 0.3, dJitter: 0.15, tilt: 4, arc: -0.15, jitter: 2.5, seed: 22, blur: 1.5, dim: 0.35, darkRatio: 0.5 },
	{ name: 'rows-touching-2x12', w: 4000, h: 3000, bg: 'table', rows: 2, n: 12, H: 920, d: 0.33, dJitter: 0.06, tilt: 1, arc: 0, jitter: 1, seed: 23, rowGap: -0.065 },
	{ name: 'rows-irregular-2x14', w: 4000, h: 3000, bg: 'paper', rows: 2, n: 14, H: 800, d: 0.33, dJitter: 0.28, tilt: -1.5, arc: 0.05, jitter: 3.5, seed: 24 },
	{ name: 'rows-tilt20-2x12', w: 4000, h: 3000, bg: 'table', rows: 2, n: 12, H: 700, d: 0.33, dJitter: 0.08, tilt: 20, arc: 0, jitter: 1.5, seed: 25 },
	{ name: 'rows-rot270-2x12', w: 4000, h: 3000, bg: 'black', rows: 2, n: 12, H: 880, d: 0.33, dJitter: 0.08, tilt: -2, arc: 0.06, jitter: 1.5, seed: 26, rotate: 270 },
	{ name: 'rows-glare-2x13', w: 4000, h: 3000, bg: 'table', rows: 2, n: 13, H: 860, d: 0.32, dJitter: 0.08, tilt: 1, arc: 0.05, jitter: 1.5, seed: 27, glare: [0.55, 0.35, 0.16] },
	{ name: 'rows-mixed-15-4', w: 4000, h: 3000, bg: 'darkmat', rows: 2, rowCounts: [15, 4], n: 15, H: 800, d: 0.31, dJitter: 0.1, tilt: -1, arc: 0.05, jitter: 2, seed: 28 },
	{ name: 'rows-darkart-black-2x15', w: 4000, h: 3000, bg: 'black', rows: 2, n: 15, H: 800, d: 0.31, dJitter: 0.1, tilt: 1.5, arc: 0.08, jitter: 2, seed: 29, darkRatio: 0.75 }
];

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
const truth = [];
let cv = null;

for (const base of scenes) {
	if (only && !only.has(base.name)) continue;
	const scene = { ...base, w: Math.round(base.w * scale), h: Math.round(base.h * scale), H: Math.round(base.H * scale) };
	const { dataUrl, cards } = await page.evaluate(render, { scene, seed });
	let buf = Buffer.from(dataUrl.split(',')[1], 'base64');
	let out = cards;
	let { w, h } = scene;
	if (scene.rotate === 90 || scene.rotate === 270) [w, h] = [h, w];
	if (scene.perspective) {
		({ buf, cards: out } = await warpScene(buf, w, h, cards, scene.perspective));
	}
	const file = `${scene.name}.jpg`;
	await sharp(buf).jpeg({ quality: 88 }).toFile(join(outDir, file));
	truth.push({ file, width: w, height: h, background: scene.bg, rotate: scene.rotate ?? 0, rows: scene.rows, perRow: scene.n, cards: out });
	console.log('wrote', file, `${w}x${h}`, out.length, 'cards');
}
// --only regenerates some scenes: keep the ground truth of the others
const truthPath = join(outDir, 'overlap-scenes.json');
const previous = only && existsSync(truthPath) ? JSON.parse(readFileSync(truthPath, 'utf8')).filter((t) => !truth.some((n) => n.file === t.file)) : [];
writeFileSync(truthPath, JSON.stringify([...previous, ...truth].sort((a, b) => a.file.localeCompare(b.file)), null, 1));
await browser.close();

/** Perspective (keystone) in Node: OpenCV warps the rendered photo and the ground-truth corners alike. */
async function warpScene(buf, w, h, cards, offsets) {
	if (!cv) {
		if (!process.env.OPENCV_JS) throw new Error('set OPENCV_JS for the perspective scenes');
		cv = createRequire(import.meta.url)(process.env.OPENCV_JS);
		for (let i = 0; i < 600 && !cv.Mat; i++) await new Promise((r) => setTimeout(r, 50));
	}
	const { data } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const src = cv.matFromArray(h, w, cv.CV_8UC4, data);
	const from = [[0, 0], [w, 0], [w, h], [0, h]];
	const to = from.map(([x, y], i) => [x + offsets[i][0] * w, y + offsets[i][1] * h]);
	const m = cv.getPerspectiveTransform(cv.matFromArray(4, 1, cv.CV_32FC2, from.flat()), cv.matFromArray(4, 1, cv.CV_32FC2, to.flat()));
	const dst = new cv.Mat();
	cv.warpPerspective(src, dst, m, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
	const k = m.data64F;
	const map = ([x, y]) => {
		const z = k[6] * x + k[7] * y + k[8];
		return [(k[0] * x + k[1] * y + k[2]) / z, (k[3] * x + k[4] * y + k[5]) / z];
	};
	const png = await sharp(Buffer.from(dst.data), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
	src.delete(); dst.delete(); m.delete();
	return { buf: png, cards: cards.map((c) => ({ ...c, corners: c.corners.map(map) })) };
}

/** Runs in the page: draws the scene, returns the JPEG and the cards with their corners. */
function render({ scene, seed }) {
	let s = scene.seed >>> 0;
	const rnd = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const between = (a, b) => a + (b - a) * rnd();
	const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 0.5;
	const rad = (deg) => (deg * Math.PI) / 180;

	const c = document.getElementById('c');
	const rotated = scene.rotate === 90 || scene.rotate === 270;
	const work = document.createElement('canvas');
	work.width = scene.w; work.height = scene.h;
	const ctx = work.getContext('2d');

	// ---- background ----
	const W0 = scene.w, H0 = scene.h;
	if (scene.bg === 'table') {
		ctx.fillStyle = '#c4a57c'; ctx.fillRect(0, 0, W0, H0);
		for (let i = 0; i < 260; i++) {
			const y = rnd() * H0, hgt = between(4, 40);
			ctx.fillStyle = `rgba(${rnd() < 0.5 ? '90,60,30' : '235,210,170'},${between(0.04, 0.14)})`;
			ctx.fillRect(0, y, W0, hgt);
		}
	} else if (scene.bg === 'paper') {
		ctx.fillStyle = '#ebe8e1'; ctx.fillRect(0, 0, W0, H0);
	} else if (scene.bg === 'black') {
		ctx.fillStyle = '#111214'; ctx.fillRect(0, 0, W0, H0);
	} else {
		// dark woven play mat with a faint printed graphic
		ctx.fillStyle = '#1b1f27'; ctx.fillRect(0, 0, W0, H0);
		for (let i = 0; i < 30; i++) {
			const g = ctx.createRadialGradient(rnd() * W0, rnd() * H0, 0, rnd() * W0, rnd() * H0, between(200, 900));
			g.addColorStop(0, `hsla(${between(0, 360)},40%,${between(18, 30)}%,0.5)`); g.addColorStop(1, 'rgba(0,0,0,0)');
			ctx.fillStyle = g; ctx.fillRect(0, 0, W0, H0);
		}
		const step = 6;
		for (let y = 0; y < H0; y += step) for (let x = (y / step) % 2 ? 0 : step; x < W0; x += 2 * step) {
			ctx.fillStyle = `rgba(255,255,255,${0.025 + 0.03 * rnd()})`; ctx.fillRect(x, y, step, step);
		}
	}
	// grain
	for (let i = 0; i < (W0 * H0) / 400; i++) {
		ctx.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${rnd() * 0.06})`;
		ctx.fillRect(rnd() * W0, rnd() * H0, 2, 2);
	}

	// ---- cards ----
	const pool = [...seed];
	for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
	const H = scene.H, W = Math.round(H * 0.716);
	const frames = ['#c9c2a5', '#3a6fc8', '#2b2b30', '#c8433a', '#3aa05a', '#c9a23a', '#8a8f96', '#a07850'];
	const modern = new Set(['tmt', 'tmc', 'pza', 'fdn']);
	const totals = { mid: 277, vow: 277, tmt: 190, tmc: 120, m10: 249, mh2: 303, rvr: 291 };

	function drawCard(card) {
		const r = (f) => H * f;
		ctx.fillStyle = '#121212'; ctx.beginPath(); ctx.roundRect(0, 0, W, H, r(0.035)); ctx.fill();
		const frame = card.frame;
		// the coloured frame ends above the wider bottom border that carries the collector lines
		ctx.fillStyle = frame; ctx.fillRect(r(0.028), r(0.028), W - 2 * r(0.028), r(0.925) - r(0.028));
		// name bar
		ctx.fillStyle = '#efe9da'; ctx.fillRect(r(0.042), r(0.04), W - 2 * r(0.042), r(0.058));
		ctx.fillStyle = '#121212'; ctx.font = `bold ${r(0.037)}px "DejaVu Serif", serif`; ctx.textBaseline = 'middle';
		ctx.fillText(card.face, r(0.058), r(0.069), W - r(0.2));
		for (let k = 0; k < 2; k++) { ctx.beginPath(); ctx.arc(W - r(0.07) - k * r(0.042), r(0.069), r(0.018), 0, Math.PI * 2); ctx.fillStyle = '#d8d3c4'; ctx.fill(); }
		// artwork: gradient plus shapes, sometimes very dark
		const dark = card.dark;
		const hue = card.hue;
		const g = ctx.createLinearGradient(0, r(0.11), W, r(0.52));
		g.addColorStop(0, `hsl(${hue},${dark ? 25 : 45}%,${dark ? 10 : 45}%)`); g.addColorStop(1, `hsl(${(hue + 60) % 360},${dark ? 20 : 40}%,${dark ? 5 : 22}%)`);
		ctx.fillStyle = g; ctx.fillRect(r(0.042), r(0.108), W - 2 * r(0.042), r(0.42));
		ctx.save(); ctx.beginPath(); ctx.rect(r(0.042), r(0.108), W - 2 * r(0.042), r(0.42)); ctx.clip();
		for (const sh of card.shapes) {
			ctx.fillStyle = sh.color; ctx.beginPath();
			if (sh.kind === 0) ctx.arc(sh.x * W, r(0.108) + sh.y * r(0.42), sh.s * W * 0.4, 0, Math.PI * 2);
			else { ctx.moveTo(sh.x * W, r(0.108) + sh.y * r(0.42)); ctx.lineTo((sh.x + sh.s) * W, r(0.108) + (sh.y + sh.s * 0.4) * r(0.42)); ctx.lineTo((sh.x - sh.s * 0.3) * W, r(0.108) + (sh.y + sh.s) * r(0.42)); }
			ctx.fill();
		}
		ctx.restore();
		// type line
		ctx.fillStyle = '#efe9da'; ctx.fillRect(r(0.042), r(0.533), W - 2 * r(0.042), r(0.047));
		ctx.fillStyle = '#121212'; ctx.font = `bold ${r(0.029)}px "DejaVu Serif", serif`;
		ctx.fillText(card.type_line.replace(' — ', ' - ').split(' // ')[0], r(0.058), r(0.5565), W - r(0.12));
		// text box
		ctx.fillStyle = '#f6f2e8'; ctx.fillRect(r(0.048), r(0.588), W - 2 * r(0.048), r(0.3));
		ctx.fillStyle = '#222'; ctx.font = `${r(0.026)}px "DejaVu Serif", serif`;
		const words = card.text.split(' '); let line = '', y = r(0.622);
		for (const wd of words) { const t = line ? `${line} ${wd}` : wd; if (ctx.measureText(t).width > W - 2 * r(0.075)) { ctx.fillText(line, r(0.065), y); line = wd; y += r(0.036); } else line = t; }
		if (line) ctx.fillText(line, r(0.065), y);
		// collector lines, light on the black border
		ctx.fillStyle = '#e8e8e8'; ctx.font = `${r(0.0175)}px "DejaVu Sans", sans-serif`;
		const R = card.rarity[0].toUpperCase();
		const set = card.set_code.toUpperCase();
		if (modern.has(card.set_code)) {
			ctx.fillText(`${R} ${card.collector_number.padStart(4, '0')}`, r(0.045), r(0.947));
		} else {
			ctx.fillText(`${card.collector_number.padStart(3, '0')}/${totals[card.set_code] ?? 280} ${R}`, r(0.045), r(0.947));
		}
		ctx.fillText(`${set} • EN`, r(0.045), r(0.972));
		ctx.font = `italic ${r(0.0165)}px "DejaVu Sans", sans-serif`;
		ctx.fillText('Artist Name', r(0.2), r(0.972));
		ctx.fillText('™ & © 2025 Wizards', W - r(0.3), r(0.972));
	}

	const texts = ['Flying. When this creature enters, draw a card.', 'Deal 2 damage to any target.', 'Target creature gets +2/+2 until end of turn.', 'Counter target spell unless its controller pays 2.', 'Vigilance, trample. At the beginning of your upkeep, create a token.'];
	const cards = [];
	// the next row must not cover the bottom of the row above: strongly arced rows swing their end cards
	const rowGap = (0.07 + (scene.rowGap ?? 0)) * H;
	const counts = scene.rowCounts ?? Array.from({ length: scene.rows }, () => scene.n);
	// layout first (origin at 0,0), then centred on the photo, then drawn row by row, card by card
	const layout = [];
	let used = 0;
	const ct = Math.cos(rad(scene.tilt)), st = Math.sin(rad(scene.tilt));
	counts.forEach((n, row) => {
		// left edge positions along the row
		const offsets = [0];
		for (let i = 1; i < n; i++) offsets.push(offsets[i - 1] + scene.d * W * (1 + scene.dJitter * gauss()));
		const span = offsets[n - 1] + W;
		const arcAt = (u) => { const t = (u - span / 2) / (span / 2); return -scene.arc * H * t * t; };
		const slopeAt = (u) => { const t = (u - span / 2) / (span / 2); return (-scene.arc * H * 2 * t) / (span / 2); };
		// rows start below each other perpendicular to the row direction
		const ox = -st * row * (H + rowGap), oy = ct * row * (H + rowGap);
		const rowCards = [];
		for (let i = 0; i < n; i++) {
			const card = pool[used++ % pool.length];
			const u = offsets[i], v = arcAt(u) + gauss() * 0.01 * H;
			const angle = rad(scene.tilt) + Math.atan(slopeAt(u)) + rad(scene.jitter * gauss() * 0.6);
			const tl = [ox + u * ct - v * st, oy + u * st + v * ct];
			const ca = Math.cos(angle), sa = Math.sin(angle);
			const corners = [tl, [tl[0] + W * ca, tl[1] + W * sa], [tl[0] + W * ca - H * sa, tl[1] + W * sa + H * ca], [tl[0] - H * sa, tl[1] + H * ca]];
			const shapes = Array.from({ length: 6 }, () => ({ kind: rnd() < 0.5 ? 0 : 1, x: rnd(), y: rnd(), s: between(0.1, 0.5), color: `hsla(${between(0, 360)},50%,${between(15, 75)}%,${between(0.4, 0.9)})` }));
			const meta = { ...card, frame: frames[Math.floor(rnd() * frames.length)], dark: rnd() < (scene.darkRatio ?? 0.3), hue: between(0, 360), shapes, text: texts[Math.floor(rnd() * texts.length)] };
			rowCards.push({ meta, angle, out: { name: card.name, face: card.face, set: card.set_code, number: card.collector_number, rarity: card.rarity, lang: 'en', row, index: i, corners } });
		}
		layout.push(rowCards);
	});
	const all = layout.flat().flatMap((c) => c.out.corners);
	const minX = Math.min(...all.map((p) => p[0])), maxX = Math.max(...all.map((p) => p[0]));
	const minY = Math.min(...all.map((p) => p[1])), maxY = Math.max(...all.map((p) => p[1]));
	const dx = (W0 - (maxX - minX)) / 2 - minX, dy = (H0 - (maxY - minY)) / 2 - minY;
	for (const rowCards of layout) {
		for (const c of rowCards) {
			c.out.corners = c.out.corners.map(([x, y]) => [x + dx, y + dy]);
			const tl = c.out.corners[0];
			ctx.save();
			ctx.translate(tl[0], tl[1]); ctx.rotate(c.angle);
			ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 0.012 * H; ctx.shadowOffsetX = 0.004 * H; ctx.shadowOffsetY = 0.004 * H;
			ctx.fillStyle = '#000'; ctx.beginPath(); ctx.roundRect(0, 0, W, H, 0.035 * H); ctx.fill();
			ctx.shadowColor = 'transparent';
			drawCard(c.meta);
			ctx.restore();
		}
		// visible fraction: where the next card's left edge crosses this card, in this card's frame
		for (let i = 0; i < rowCards.length; i++) {
			const cur = rowCards[i].out;
			if (i === rowCards.length - 1) { cur.visible = 1; cur.full = true; continue; }
			const nxt = rowCards[i + 1].out;
			const [tx, ty] = cur.corners[0];
			const ca = Math.cos(rowCards[i].angle), sa = Math.sin(rowCards[i].angle);
			const local = ([x, y]) => (x - tx) * ca + (y - ty) * sa;
			cur.visible = Math.max(0, Math.min(1, (local(nxt.corners[0]) + local(nxt.corners[3])) / 2 / W));
			cur.full = false;
		}
		for (const c of rowCards) cards.push(c.out);
	}
	if (minX + dx < 0 || minY + dy < 0 || maxX + dx > W0 || maxY + dy > H0) console.warn(`${scene.name}: cards reach beyond the photo`);

	// a lamp reflected on the cards
	if (scene.glare) {
		const [gx, gy, gr] = scene.glare;
		const gg = ctx.createRadialGradient(gx * W0, gy * H0, 0, gx * W0, gy * H0, gr * Math.hypot(W0, H0));
		gg.addColorStop(0, 'rgba(255,255,255,0.75)'); gg.addColorStop(0.5, 'rgba(255,255,255,0.3)'); gg.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = gg; ctx.fillRect(0, 0, W0, H0);
	}
	// a dim room
	if (scene.dim) { ctx.fillStyle = `rgba(0,0,0,${scene.dim})`; ctx.fillRect(0, 0, W0, H0); }
	// lighting: a soft gradient and a vignette
	const lg = ctx.createRadialGradient(W0 * 0.3, H0 * 0.25, 0, W0 * 0.5, H0 * 0.5, Math.hypot(W0, H0) * 0.6);
	lg.addColorStop(0, 'rgba(255,255,240,0.10)'); lg.addColorStop(0.6, 'rgba(0,0,0,0)'); lg.addColorStop(1, 'rgba(0,0,0,0.28)');
	ctx.fillStyle = lg; ctx.fillRect(0, 0, W0, H0);

	// final canvas: optional blur and rotation of the whole photo
	c.width = rotated ? H0 : W0; c.height = rotated ? W0 : H0;
	const out = c.getContext('2d');
	out.save();
	if (scene.blur) out.filter = `blur(${scene.blur}px)`;
	const rot = rad(scene.rotate ?? 0);
	out.translate(c.width / 2, c.height / 2); out.rotate(rot); out.drawImage(work, -W0 / 2, -H0 / 2);
	out.restore();
	const mapPt = ([x, y]) => {
		const dx = x - W0 / 2, dy = y - H0 / 2;
		return [c.width / 2 + dx * Math.cos(rot) - dy * Math.sin(rot), c.height / 2 + dx * Math.sin(rot) + dy * Math.cos(rot)];
	};
	for (const card of cards) card.corners = card.corners.map(mapPt);
	return { dataUrl: c.toDataURL('image/png'), cards };
}
