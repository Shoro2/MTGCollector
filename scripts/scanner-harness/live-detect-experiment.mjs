// Offline experiment for the live card detector (`detectOnPixels`): runs the
// very code the phone runs per frame on still images, without a browser.
//
//   OPENCV_JS=/path/to/opencv.js npx tsx scripts/scanner-harness/live-detect-experiment.mjs --out DIR photo.jpg ...
//   OPENCV_JS=... npx tsx scripts/scanner-harness/live-detect-experiment.mjs --out DIR --truth scenes/scenes.json [--old old-quick-rects.ts]
//
// Every image is scaled like a live frame (long edge 720 px, the analysis
// canvas of LiveScanner), handed to the detector as RGBA, and the result is
// printed (corners, size, aspect, luminance spread) and drawn over the frame
// as DIR/<image>-live.png. With --truth (make-mat-scenes.mjs) the detections
// are scored against the known card corners: found (box IoU >= 0.72: the inner frame of a card counts, the pipeline expands it), corner
// error in percent of the card's long edge, false positives (IoU < 0.5);
// --old scores a second detector module (e.g. `git show master:...`) on the
// same frames. OpenCV.js comes from OPENCV_JS (the npm package
// `@techstark/opencv-js@4.9.0-release.3`, dist/opencv.js — the build
// vendor-assets.mjs fetches), because the repository does not ship it.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { detectOnPixels } from '../../src/lib/scanner/quick-rects.ts';
import { polygonOrder, quadAspect, quadSides } from '../../src/lib/scanner/quad.ts';

const args = process.argv.slice(2);
let outDir = 'live-detect-experiment', longEdge = 720, truthPath = null, oldPath = null, draw = true, detOpts = {};
const photos = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--out') outDir = args[++i];
	else if (args[i] === '--long-edge') longEdge = Number(args[++i]);
	else if (args[i] === '--truth') truthPath = args[++i];
	else if (args[i] === '--old') oldPath = args[++i];
	else if (args[i] === '--no-draw') draw = false;
	else if (args[i] === '--opts') detOpts = JSON.parse(args[++i]);
	else photos.push(args[i]);
}
mkdirSync(outDir, { recursive: true });
if (!process.env.OPENCV_JS) throw new Error('set OPENCV_JS to the path of opencv.js');

const require = createRequire(import.meta.url);
const cv = require(process.env.OPENCV_JS);
// The Emscripten module is a thenable that never settles: poll for the runtime instead of awaiting it.
for (let i = 0; i < 600 && !cv.Mat; i++) await new Promise((r) => setTimeout(r, 50));
if (!cv.Mat) throw new Error('OpenCV runtime did not initialise');

const detectors = [{ name: 'current', run: (c, px, w, h) => detectOnPixels(c, px, w, h, detOpts) }];
if (oldPath) detectors.unshift({ name: 'old', run: (await import(pathToFileURL(resolve(oldPath)).href)).detectOnPixels });

const truth = truthPath ? JSON.parse(readFileSync(truthPath, 'utf8')) : null;
const files = truth ? truth.map((s) => join(dirname(truthPath), s.file)) : photos;

const bbox = (q) => {
	const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
	return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};
const iou = (a, b) => {
	const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
	if (x2 <= x1 || y2 <= y1) return 0;
	const i = (x2 - x1) * (y2 - y1);
	return i / (a.w * a.h + b.w * b.h - i);
};
/** Mean corner distance under the best cyclic alignment (either winding), in percent of the truth's long edge. */
function cornerError(det, tru) {
	const d = polygonOrder(det), t = polygonOrder(tru);
	const long = Math.max(...quadSides(t));
	let best = Infinity;
	for (const cand of [d, [...d].reverse()]) {
		for (let s = 0; s < 4; s++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) sum += Math.hypot(cand[(k + s) % 4][0] - t[k][0], cand[(k + s) % 4][1] - t[k][1]);
			best = Math.min(best, sum / 4);
		}
	}
	return (best / long) * 100;
}

const stats = new Map();
const bucket = (det, bg) => {
	const k = `${det}|${bg}`;
	if (!stats.has(k)) stats.set(k, { scenes: 0, found: 0, errs: [], fp: 0, ms: 0, misses: [], tpSpread: [], fpSpread: [] });
	return stats.get(k);
};

for (const [idx, file] of files.entries()) {
	const img = sharp(file).rotate();
	const meta = await img.metadata();
	const W0 = meta.autoOrient?.width ?? meta.width, H0 = meta.autoOrient?.height ?? meta.height;
	const scale = longEdge / Math.max(W0, H0);
	const w = Math.round(W0 * scale), h = Math.round(H0 * scale);
	const { data } = await img.resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
	const polys = [];
	for (const det of detectors) {
		const t0 = performance.now();
		const result = det.run(cv, rgba, w, h);
		const ms = performance.now() - t0;
		if (!truth) {
			console.log(`\n${basename(file)} (${w}x${h}) [${det.name}]: ${result.rects.length} rect(s) in ${ms.toFixed(0)} ms`);
			result.rects.forEach((r, i) => {
				const s = quadSides(polygonOrder(r.corners));
				console.log(`  #${i + 1} ${r.source ?? '-'}: ${r.corners.map((c) => `(${Math.round(c[0])},${Math.round(c[1])})`).join(' ')}  ${Math.round(Math.min(s[0], s[1]))}x${Math.round(Math.max(s[0], s[1]))}  aspect ${quadAspect(r.corners).toFixed(3)}  spread ${Math.round(r.spread ?? -1)}  area ${((r.area / (w * h)) * 100).toFixed(1)}%`);
			});
		} else {
			const sc = truth[idx];
			const tq = sc.corners.map((p) => [p[0] * scale, p[1] * scale]);
			const b = bucket(det.name, sc.background);
			b.scenes++;
			b.ms += ms;
			let best = null;
			for (const r of result.rects) {
				const v = iou(bbox(r.corners), bbox(tq));
				if (!best || v > best.v) best = { v, r };
				if (v < 0.5) { b.fp++; b.fpSpread.push(Math.round(r.spread ?? -1)); } else b.tpSpread.push(Math.round(r.spread ?? -1));
			}
			if (best && best.v >= 0.72) {
				b.found++;
				b.errs.push(cornerError(best.r.corners, tq));
			} else b.misses.push(`${sc.file} (${sc.card.name}, ${sc.card.colors}, ${sc.angle} deg, x${sc.brightness})${best ? ` best IoU ${best.v.toFixed(2)}` : ''}`);
		}
		for (const r of result.rects) polys.push(`<polygon points="${r.corners.map((c) => c.join(',')).join(' ')}" fill="none" stroke="${det.name === 'old' ? '#ff3bd4' : r.source === 'coarse' ? '#3bd4ff' : '#3bff6f'}" stroke-width="3"/>`);
	}
	if (draw) {
		const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${polys.join('')}</svg>`);
		await sharp(data, { raw: { width: w, height: h, channels: 4 } }).composite([{ input: svg }]).png().toFile(join(outDir, basename(file).replace(/[^A-Za-z0-9_.-]/g, '_') + '-live.png'));
	}
}

if (truth) {
	console.log('detector  background  scenes  found  corner err mean / p90 (% of long edge)  false pos  ms/frame');
	for (const [k, b] of stats) {
		const [det, bg] = k.split('|');
		const e = [...b.errs].sort((x, y) => x - y);
		const mean = e.length ? e.reduce((s, v) => s + v, 0) / e.length : NaN;
		const p90 = e.length ? e[Math.min(e.length - 1, Math.round(0.9 * (e.length - 1)))] : NaN;
		console.log(`${det.padEnd(9)} ${bg.padEnd(11)} ${String(b.scenes).padStart(6)}  ${String(b.found).padStart(5)}  ${mean.toFixed(2).padStart(6)} / ${p90.toFixed(2).padStart(6)}${' '.repeat(26)}${String(b.fp).padStart(6)}  ${(b.ms / b.scenes).toFixed(0).padStart(7)}`);
	}
	for (const [k, b] of stats) if (k.startsWith('current|')) console.log(`spread on ${k.split('|')[1]}: cards min ${Math.min(...b.tpSpread)} / p10 ${[...b.tpSpread].sort((x, y) => x - y)[Math.floor(b.tpSpread.length * 0.1)]}; false positives ${JSON.stringify(b.fpSpread.sort((x, y) => x - y))}`);
	for (const [k, b] of stats) {
		if (!k.startsWith('current|') || !b.misses.length) continue;
		console.log(`\nmissed by the current detector on ${k.split('|')[1]}:`);
		for (const m of b.misses) console.log('  ' + m);
	}
}
