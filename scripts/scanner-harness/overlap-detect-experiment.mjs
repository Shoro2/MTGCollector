// Offline experiment for the "rows" scan mode (overlapping cards): runs the
// segment extraction (overlap-cv.ts) and the row model (overlap.ts) that the
// page runs, on still photos in Node, without a browser.
//
//   OPENCV_JS=/path/to/opencv.js npx tsx scripts/scanner-harness/overlap-detect-experiment.mjs --truth DIR/overlap-scenes.json --out OUT [--only name] [--segments]
//   OPENCV_JS=... npx tsx scripts/scanner-harness/overlap-detect-experiment.mjs --out OUT photo.jpg ...
//
// Every photo is scaled like the page scales it for detection (long edge
// 1600 px, DETECT_MAX_EDGE in /scan), the detected cards are drawn over it as
// OUT/<photo>-rows.png (green: matches a card of the ground truth, red: no
// such card, blue outline: a card of the ground truth nobody found; the
// visible strip filled, the full card outlined) and, with --truth
// (make-overlap-scenes.mjs), scored: found (left-edge corners within 6 % of
// the card height), corner error of all four corners in percent of the card
// height, error of the visible fraction, extra detections, the rotation.
// --segments also draws the raw line segments (OUT/<photo>-seg.png).
// --resize sharp scales with sharp (Lanczos) instead of OpenCV's INTER_AREA
// on the full-resolution grayscale, which is what the page does in rows mode.
// OpenCV.js comes from OPENCV_JS (the build vendor-assets.mjs fetches into
// static/vendor/opencv.js; Node needs it under a .cjs name when the
// repository's package.json says "type": "module").
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import { extractSegments } from '../../src/lib/scanner/overlap-cv.ts';
import { detectOverlapRows } from '../../src/lib/scanner/overlap.ts';

const args = process.argv.slice(2);
let outDir = 'overlap-experiment', truthPath = null, longEdge = 1600, drawSegments = false, only = null, verbose = false, resize = 'area';
const photos = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--out') outDir = args[++i];
	else if (args[i] === '--truth') truthPath = args[++i];
	else if (args[i] === '--long-edge') longEdge = Number(args[++i]);
	else if (args[i] === '--segments') drawSegments = true;
	else if (args[i] === '--only') only = args[++i].split(',');
	else if (args[i] === '--verbose') verbose = true;
	else if (args[i] === '--resize') resize = args[++i];
	else photos.push(args[i]);
}
mkdirSync(outDir, { recursive: true });
if (!process.env.OPENCV_JS) throw new Error('set OPENCV_JS to the path of opencv.js');
const cv = createRequire(import.meta.url)(process.env.OPENCV_JS);
// The Emscripten module is a thenable that never settles: poll for the runtime instead of awaiting it.
for (let i = 0; i < 600 && !cv.Mat; i++) await new Promise((r) => setTimeout(r, 50));
if (!cv.Mat) throw new Error('OpenCV runtime did not initialise');

const truth = truthPath ? JSON.parse(readFileSync(truthPath, 'utf8')) : null;
const items = truth
	? truth.map((s) => ({ path: join(dirname(truthPath), s.file), scene: s }))
	: photos.map((p) => ({ path: p, scene: null }));
const total = { scenes: 0, cards: 0, found: 0, extra: 0, cornerErr: [], visErr: [], ms: [], rotationOk: 0, edges: {} };
const report = [];

for (const { path, scene } of items) {
	if (only && !only.some((n) => path.includes(n))) continue;
	const meta = await sharp(path).metadata();
	const k = Math.min(1, longEdge / Math.max(meta.width, meta.height));
	const w = Math.round(meta.width * k), h = Math.round(meta.height * k);
	let data;
	if (resize === 'sharp') ({ data } = await sharp(path).resize(w, h).grayscale().raw().toBuffer({ resolveWithObject: true }));
	else {
		// like the page: grayscale at full resolution, then INTER_AREA down to the detection size
		const full = await sharp(path).grayscale().raw().toBuffer({ resolveWithObject: true });
		const big = cv.matFromArray(full.info.height, full.info.width, cv.CV_8UC1, full.data);
		const small = new cv.Mat();
		cv.resize(big, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
		data = Buffer.from(small.data);
		big.delete(); small.delete();
	}
	const t0 = performance.now();
	const gray = cv.matFromArray(h, w, cv.CV_8UC1, data);
	const segments = extractSegments(cv, gray);
	gray.delete();
	const t1 = performance.now();
	const layout = detectOverlapRows(segments, w, h, { data, width: w, height: h }, { verbose });
	const t2 = performance.now();
	const cards = layout?.cards ?? [];

	// ---- scoring against the ground truth (corners scaled to the detection copy)
	const tcards = scene ? scene.cards.map((c) => ({ ...c, corners: c.corners.map(([x, y]) => [x * k, y * k]) })) : [];
	const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
	const used = new Set();
	const matches = [];
	for (const d of cards) {
		let best = null;
		for (let i = 0; i < tcards.length; i++) {
			if (used.has(i)) continue;
			const t = tcards[i];
			const H = dist(t.corners[0], t.corners[3]);
			const e = (dist(d.corners[0], t.corners[0]) + dist(d.corners[3], t.corners[3])) / 2 / H;
			if (e < 0.06 && (!best || e < best.e)) best = { i, e, H };
		}
		if (best) {
			used.add(best.i);
			const t = tcards[best.i];
			const err = d.corners.reduce((s, p, j) => s + dist(p, t.corners[j]), 0) / 4 / best.H;
			matches.push({ d, t, err, vis: Math.abs(d.visible - t.visible) });
		} else matches.push({ d, t: null });
	}
	const found = matches.filter((m) => m.t).length;
	const extra = matches.length - found;
	const rowLine = `${basename(path)}: ${cards.length} detected` + (scene ? `, ${found}/${tcards.length} found, ${extra} extra` : '') +
		(found ? `, corner error ${(100 * mean(matches.filter((m) => m.t).map((m) => m.err))).toFixed(1)} %, visible error ${(100 * mean(matches.filter((m) => m.t).map((m) => m.vis))).toFixed(1)} pp` : '') +
		`, rotation ${layout ? layout.rotation.toFixed(1) : '-'}${scene ? ` (truth ${scene.rotate})` : ''}, segments ${(t1 - t0).toFixed(0)} ms, rows ${(t2 - t1).toFixed(0)} ms`;
	console.log(rowLine);
	if (verbose && layout) for (const l of layout.log) console.log('   ', l);
	if (verbose && scene) {
		// signed errors of the top and bottom edge along the card's axis, in card heights (+ = too low)
		const lines = [];
		for (const m of matches) {
			if (!m.t) { lines.push(`${m.d.row}.${m.d.index}: extra`); continue; }
			const [t0, , , t3] = m.t.corners;
			const H = dist(t0, t3), down = [(t3[0] - t0[0]) / H, (t3[1] - t0[1]) / H];
			const along = (p, q) => ((p[0] - q[0]) * down[0] + (p[1] - q[1]) * down[1]) / H;
			const side = (p, q) => ((p[0] - q[0]) * -down[1] + (p[1] - q[1]) * down[0]) / H;
			const t1 = m.t.corners[1];
			const angle = (Math.atan2(m.d.corners[3][0] - m.d.corners[0][0], m.d.corners[3][1] - m.d.corners[0][1]) - Math.atan2(t3[0] - t0[0], t3[1] - t0[1])) * 180 / Math.PI;
			lines.push(`${m.d.row}.${m.d.index}${m.d.edge === 'detected' ? '' : m.d.edge[0]}: top ${(100 * along(m.d.corners[0], t0)).toFixed(1)} bot ${(100 * along(m.d.corners[3], t3)).toFixed(1)} left ${(100 * side(m.d.corners[0], t0)).toFixed(1)} right ${(100 * side(m.d.corners[1], t1)).toFixed(1)} angle ${angle.toFixed(1)}`);
		}
		console.log('    truth:', lines.join(' | '));
	}
	report.push({ file: basename(path), detected: cards.length, found, total: tcards.length, extra, rotation: layout?.rotation ?? null, log: layout?.log ?? [] });
	if (scene) {
		total.scenes++;
		total.cards += tcards.length;
		total.found += found;
		total.extra += extra;
		for (const m of matches) if (m.t) { total.cornerErr.push(m.err); total.visErr.push(m.vis); }
		for (const m of matches) {
			const e = (total.edges[m.d.edge] ??= { found: 0, extra: 0 });
			if (m.t) e.found++;
			else e.extra++;
		}
		if (layout) {
			const diff = Math.abs((((layout.rotation - scene.rotate) % 360) + 540) % 360 - 180);
			if (diff < 30) total.rotationOk++;
		}
	}
	total.ms.push(t2 - t0);

	// ---- drawing
	const poly = (q) => q.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
	let svg = '';
	for (const m of matches) {
		const col = !scene ? '#00e0ff' : m.t ? '#00ff66' : '#ff2040';
		svg += `<polygon points="${poly(m.d.strip)}" fill="${col}" fill-opacity="0.22" stroke="${col}" stroke-width="2"/>`;
		svg += `<polygon points="${poly(m.d.corners)}" fill="none" stroke="${col}" stroke-width="1" stroke-dasharray="6,4"/>`;
		svg += `<text x="${m.d.corners[0][0] + 4}" y="${m.d.corners[0][1] + 16}" font-size="14" fill="${col}" font-family="sans-serif">${m.d.row}.${m.d.index}${m.d.edge === 'detected' ? '' : m.d.edge[0]}</text>`;
	}
	tcards.forEach((t, i) => {
		if (!used.has(i)) svg += `<polygon points="${poly(t.corners)}" fill="none" stroke="#3080ff" stroke-width="3"/>`;
	});
	await sharp(path).resize(w, h).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svg}</svg>`) }]).png().toFile(join(outDir, basename(path).replace(/\.\w+$/, '-rows.png')));
	if (drawSegments) {
		const lines = segments.map(([x1, y1, x2, y2]) => {
			const a = Math.abs((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI) % 180;
			const col = a > 60 && a < 120 ? 'red' : a < 30 || a > 150 ? 'lime' : 'yellow';
			return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="2"/>`;
		}).join('');
		await sharp(path).resize(w, h).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${lines}</svg>`) }]).png().toFile(join(outDir, basename(path).replace(/\.\w+$/, '-seg.png')));
	}
}
if (total.scenes) {
	console.log(`\nTOTAL ${total.scenes} scenes: found ${total.found}/${total.cards}, extra ${total.extra}, corner error mean ${(100 * mean(total.cornerErr)).toFixed(1)} % (p90 ${(100 * quantile(total.cornerErr, 0.9)).toFixed(1)} %), visible error mean ${(100 * mean(total.visErr)).toFixed(1)} pp, rotation right ${total.rotationOk}/${total.scenes}, mean time ${mean(total.ms).toFixed(0)} ms`);
	console.log(`edges: ${Object.entries(total.edges).map(([k, v]) => `${k} ${v.found} found / ${v.extra} extra`).join(', ')}`);
}
writeFileSync(join(outDir, 'overlap-report.json'), JSON.stringify(report, null, 1));
process.exit(0);

function mean(v) { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
function quantile(v, q) { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))] : 0; }
