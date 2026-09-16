// Name-band preprocessing experiment: run each photo through /scan (dev server
// on 127.0.0.1:5173, self-hosted Tesseract under /vendor), then re-OCR every
// name crop with several preprocessings (as produced by the page: 1.5x gray)
// and page-segmentation modes and count hits against the expectations. Reports
// per-variant hits and the union with the two passes the page already runs
// (PSM 7 on the 1.5x crop, PSM 13 on the 2x crop), so a third pass can be
// chosen on evidence. Variants are plain canvas pixel math, no OpenCV.
// usage: node scripts/scanner-harness/ocr-preprocess-experiment.mjs [--json out.json] photos/*.jpg
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const argv = process.argv.slice(2);
const jsonIdx = argv.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? argv.splice(jsonIdx, 2)[1] : null;
const files = argv;
const expectations = JSON.parse(readFileSync('scripts/scanner-harness/expectations-real-photos.json', 'utf8'));
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const dump = [];
const totals = {};
for (const file of files) {
	const expNames = (expectations[basename(file)] || []).map((e) => (typeof e === 'string' ? e : e.name));
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.goto(`${process.env.HARNESS_URL ?? 'http://localhost:5173'}/scan`, { waitUntil: 'networkidle' });
	await page.getByRole('button', { name: 'Multiple cards' }).click();
	await page.setInputFiles('input[type=file]', file);
	await page.waitForFunction(() => /Scan complete:|No cards detected|Error:/.test(document.querySelector('pre')?.textContent ?? ''), null, { timeout: 600000 });
	const out = await page.evaluate(async ({ expNames }) => {
		const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
		const aliases = (n) => { const f = n.split(' // '); return f.length > 1 ? [n, ...f] : [n]; };
		const bigrams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); m.set(b, (m.get(b) || 0) + 1); } return m; };
		const dice = (a, b) => { a = norm(a); b = norm(b); if (a.length < 2 || b.length < 2) return 0; const A = bigrams(a), B = bigrams(b); let inter = 0; for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0); return (2 * inter) / ((a.length - 1) + (b.length - 1)); };
		const bestName = (t) => Math.max(0, ...expNames.flatMap(aliases).map((n) => dice(t, n)));
		const cards = Array.from(document.querySelectorAll('h3')).filter((h) => /^Card \d+/.test(h.innerText.trim())).map((h, i) => {
			const b = h.closest('.rounded-lg');
			const imgs = Array.from(b.querySelectorAll('img')).map((im) => ({ src: im.getAttribute('src'), w: im.naturalWidth, h: im.naturalHeight }));
			const wide = imgs.filter((im) => im.w > im.h * 3);
			return { idx: i + 1, name: wide[0]?.src, resolved: b.dataset.state === 'confirmed' };
		});
		const T = await import('/vendor/tesseract/tesseract.esm.min.js');
		const createWorker = T.createWorker || T.default?.createWorker;
		const worker = await createWorker('eng', 1, { workerPath: '/vendor/tesseract/worker.min.js', corePath: '/vendor/tesseract/core', langPath: '/vendor/tesseract/lang', gzip: true });
		const WL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',-.";
		const load = async (url) => { const img = new Image(); img.src = url; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); return c; };
		const gray = (c) => { const ctx = c.getContext('2d'); const d = ctx.getImageData(0, 0, c.width, c.height); const g = new Uint8ClampedArray(c.width * c.height); for (let i = 0, j = 0; i < d.data.length; i += 4, j++) g[j] = Math.round(0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]); return g; };
		const toCanvas = (g, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d'); const d = ctx.createImageData(w, h); for (let j = 0, i = 0; j < g.length; j++, i += 4) { d.data[i] = d.data[i + 1] = d.data[i + 2] = g[j]; d.data[i + 3] = 255; } ctx.putImageData(d, 0, 0); return c; };
		const otsu = (g) => { const hist = new Array(256).fill(0); for (const v of g) hist[v]++; const total = g.length; let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t]; let sumB = 0, wB = 0, best = 0, thr = 128; for (let t = 0; t < 256; t++) { wB += hist[t]; if (wB === 0) continue; const wF = total - wB; if (wF === 0) break; sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF; const v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; thr = t; } } return thr; };
		const isLightOnDark = (g) => { let s = 0; for (const v of g) s += v; return s / g.length < 110; };
		const variants = {
			gray: (g) => g,
			invertIfDark: (g) => (isLightOnDark(g) ? g.map((v) => 255 - v) : g),
			otsu: (g) => { const t = otsu(g); return g.map((v) => (v > t ? 255 : 0)); },
			otsuDarkText: (g) => { const t = otsu(g); const dark = isLightOnDark(g); return g.map((v) => ((v > t) !== dark ? 255 : 0)); },
			stretch: (g) => { const s = Array.from(g).sort((a, b) => a - b); const lo = s[Math.floor(s.length * 0.02)], hi = s[Math.floor(s.length * 0.98)]; const r = Math.max(1, hi - lo); return g.map((v) => Math.max(0, Math.min(255, Math.round(((v - lo) / r) * 255)))); },
			blur: (g, w, h) => { const o = new Uint8ClampedArray(g.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w) { s += g[yy * w + xx]; n++; } } o[y * w + x] = Math.round(s / n); } return o; }
		};
		const scaled = (c, f) => { if (f === 1) return c; const o = document.createElement('canvas'); o.width = Math.round(c.width * f); o.height = Math.round(c.height * f); const ctx = o.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(c, 0, 0, o.width, o.height); return o; };
		const runs = [
			{ k: 'base psm7 gray x1', v: 'gray', psm: '7', f: 1 },
			{ k: 'base psm13 gray x1.33', v: 'gray', psm: '13', f: 4 / 3 },
			{ k: 'psm7 invertIfDark x1', v: 'invertIfDark', psm: '7', f: 1 },
			{ k: 'psm7 otsu x1', v: 'otsu', psm: '7', f: 1 },
			{ k: 'psm7 otsuDarkText x1', v: 'otsuDarkText', psm: '7', f: 1 },
			{ k: 'psm7 stretch x1', v: 'stretch', psm: '7', f: 1 },
			{ k: 'psm7 blur x1', v: 'blur', psm: '7', f: 1 },
			{ k: 'psm13 otsuDarkText x1.33', v: 'otsuDarkText', psm: '13', f: 4 / 3 },
			{ k: 'psm13 stretch x1.33', v: 'stretch', psm: '13', f: 4 / 3 },
			{ k: 'psm7 stretch x0.75', v: 'stretch', psm: '7', f: 0.75 },
			{ k: 'psm7 gray x0.75', v: 'gray', psm: '7', f: 0.75 }
		];
		const stats = {}; const perCard = [];
		for (const c of cards) {
			if (!c.name) continue;
			const src = await load(c.name);
			const row = { idx: c.idx, resolved: c.resolved, hits: {} };
			for (const r of runs) {
				const cs = scaled(src, r.f);
				const g = variants[r.v](gray(cs), cs.width, cs.height);
				await worker.setParameters({ tessedit_pageseg_mode: r.psm, tessedit_char_whitelist: WL });
				const o = await worker.recognize(toCanvas(g, cs.width, cs.height).toDataURL());
				const text = (o.data.text || '').replace(/\s+/g, ' ').trim();
				const hit = bestName(text) >= 0.6;
				row.hits[r.k] = { hit, text: text.slice(0, 30) };
				const s = (stats[r.k] ??= { hits: 0, n: 0 }); s.n++; if (hit) s.hits++;
			}
			perCard.push(row);
		}
		await worker.terminate();
		return { stats, perCard };
	}, { expNames });
	console.log(`\n=== ${basename(file)} (${expNames.length} expected) ===`);
	for (const [k, s] of Object.entries(out.stats)) { console.log(`  ${k.padEnd(28)} ${String(s.hits).padStart(2)}/${s.n}`); const t = (totals[k] ??= { hits: 0, n: 0 }); t.hits += s.hits; t.n += s.n; }
	dump.push({ file: basename(file), stats: out.stats, perCard: out.perCard });
	await page.close();
}
console.log('\n=== TOTALS ===');
for (const [k, t] of Object.entries(totals)) console.log(`  ${k.padEnd(28)} ${t.hits}/${t.n}`);
const union = (keys) => { let n = 0, h = 0; for (const f of dump) for (const c of f.perCard) { n++; if (keys.some((k) => c.hits[k]?.hit)) h++; } return `${h}/${n}`; };
const baseKeys = ['base psm7 gray x1', 'base psm13 gray x1.33'];
console.log(`\nunion of the two current passes: ${union(baseKeys)}`);
for (const k of Object.keys(totals)) if (!baseKeys.includes(k)) console.log(`  + ${k.padEnd(26)} -> ${union([...baseKeys, k])}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(dump, null, 1));
await browser.close();
