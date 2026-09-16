// Second-engine experiment (WP2.6): run each photo through /scan, then read
// the same name and collector crops with PaddleOCR's PP-OCRv4 recognition
// model (ONNX, via onnxruntime-web, WASM, single-threaded) and count hits
// against the expectations next to Tesseract's. Recognition only: the crops
// are already single text lines, so the detection and orientation models are
// not needed. Assets (gitignored):
//   static/vendor/ort/ort.wasm.min.mjs + ort-wasm-simd-threaded.{mjs,wasm}   (npm onnxruntime-web)
//   static/vendor/paddle/ch_PP-OCRv4_rec_infer.onnx + ppocr_keys_v1.txt       (npm @gutenye/ocr-models)
// usage: node scripts/scanner-harness/ocr-engine-experiment.mjs [--json out.json] photos/*.jpg
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
	const expected = expectations[basename(file)] || [];
	const expNames = expected.map((e) => (typeof e === 'string' ? e : e.name));
	const expNums = expected.filter((e) => typeof e === 'object').map((e) => String(e.number).replace(/^0+/, ''));
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 160)); });
	await page.goto(`${process.env.HARNESS_URL ?? 'http://localhost:5173'}/scan`, { waitUntil: 'networkidle' });
	await page.getByRole('button', { name: 'Multiple cards' }).click();
	await page.setInputFiles('input[type=file]', file);
	await page.waitForFunction(() => /Scan complete:|No cards detected|Error:/.test(document.querySelector('pre')?.textContent ?? ''), null, { timeout: 600000 });
	const out = await page.evaluate(async ({ expNames, expNums }) => {
		const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
		const aliases = (n) => { const f = n.split(' // '); return f.length > 1 ? [n, ...f] : [n]; };
		const bigrams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); m.set(b, (m.get(b) || 0) + 1); } return m; };
		const dice = (a, b) => { a = norm(a); b = norm(b); if (a.length < 2 || b.length < 2) return 0; const A = bigrams(a), B = bigrams(b); let inter = 0; for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0); return (2 * inter) / ((a.length - 1) + (b.length - 1)); };
		const bestName = (t) => Math.max(0, ...expNames.flatMap(aliases).map((n) => dice(t, n)));
		const numOf = (t) => { const f = t.match(/(\d{1,4})\/\d{1,4}/); if (f) return f[1].replace(/^0+/, ''); const r = t.match(/(?:^|\s)[CURML]{1,2}\s*0*(\d{1,4})(?!\d)/i); if (r) return r[1].replace(/^0+/, ''); const p = t.match(/(?:^|\s)(0\d{3})(?!\d)/); if (p) return p[1].replace(/^0+/, ''); return ''; };
		const cards = Array.from(document.querySelectorAll('h3')).filter((h) => /^Card \d+/.test(h.innerText.trim())).map((h, i) => {
			const b = h.closest('.rounded-lg');
			const mono = Array.from(b.querySelectorAll('p.font-mono')).map((p) => p.innerText.trim());
			const imgs = Array.from(b.querySelectorAll('img')).map((im) => ({ src: im.getAttribute('src'), w: im.naturalWidth, h: im.naturalHeight }));
			const wide = imgs.filter((im) => im.w > im.h * 3);
			return { idx: i + 1, name: wide[0]?.src, bottom: wide[1]?.src, tessName: mono[0] ?? '', tessBottom: mono[1] ?? '' };
		});
		const ort = await import('/vendor/ort/ort.wasm.min.mjs');
		ort.env.wasm.wasmPaths = '/vendor/ort/';
		ort.env.wasm.numThreads = 1;
		const session = await ort.InferenceSession.create('/vendor/paddle/ch_PP-OCRv4_rec_infer.onnx', { executionProviders: ['wasm'] });
		const keys = (await (await fetch('/vendor/paddle/ppocr_keys_v1.txt')).text()).split('\n');
		if (keys[keys.length - 1] === '') keys.pop();
		const dict = ['', ...keys, ' '];
		const load = async (url) => { const img = new Image(); img.src = url; await img.decode(); return img; };
		// PP-OCR recognition: height 48, width proportional (max 1600), RGB
		// normalised to [-1, 1], NCHW; CTC greedy decode over the dictionary.
		const recognise = async (url) => {
			const img = await load(url);
			const H = 48;
			const W = Math.max(16, Math.min(1600, Math.round((img.width * H) / img.height)));
			const c = document.createElement('canvas'); c.width = W; c.height = H;
			const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, W, H);
			const d = ctx.getImageData(0, 0, W, H).data;
			const data = new Float32Array(3 * H * W);
			for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4;
				for (let ch = 0; ch < 3; ch++) data[ch * H * W + y * W + x] = (d[i + ch] / 255 - 0.5) / 0.5;
			}
			const input = new ort.Tensor('float32', data, [1, 3, H, W]);
			const t0 = performance.now();
			const res = await session.run({ [session.inputNames[0]]: input });
			const ms = performance.now() - t0;
			const outT = res[session.outputNames[0]];
			const [, T, C] = outT.dims;
			let text = '', last = -1, confSum = 0, n = 0;
			for (let t = 0; t < T; t++) {
				let best = 0, bi = 0;
				for (let k = 0; k < C; k++) { const v = outT.data[t * C + k]; if (v > best) { best = v; bi = k; } }
				if (bi !== 0 && bi !== last) { text += dict[bi] ?? ''; confSum += best; n++; }
				last = bi;
			}
			return { text: text.trim(), conf: n ? confSum / n : 0, ms };
		};
		// The collector strip holds two text lines (number line, set line); the
		// recognition model expects one. Split by row ink density and read each
		// band (at least 12 px tall) on its own.
		const recogniseLines = async (url) => {
			const img = await load(url);
			const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
			const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
			const d = ctx.getImageData(0, 0, c.width, c.height).data;
			const rows = new Float32Array(c.height);
			for (let y = 0; y < c.height; y++) { let s = 0; for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; s += 255 - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); } rows[y] = s / c.width; }
			const sorted = Array.from(rows).sort((a, b) => a - b);
			const lo = sorted[Math.floor(sorted.length * 0.1)], hi = sorted[Math.floor(sorted.length * 0.9)];
			const thr = lo + 0.25 * (hi - lo);
			const bands = [];
			let start = -1;
			for (let y = 0; y <= c.height; y++) {
				const ink = y < c.height && rows[y] > thr;
				if (ink && start < 0) start = y;
				if (!ink && start >= 0) { if (y - start >= 12) bands.push([Math.max(0, start - 3), Math.min(c.height, y + 3)]); start = -1; }
			}
			if (bands.length === 0) bands.push([0, c.height]);
			const texts = []; let ms = 0, conf = 0;
			for (const [y0, y1] of bands.slice(0, 3)) {
				const b = document.createElement('canvas'); b.width = c.width; b.height = y1 - y0;
				b.getContext('2d').drawImage(c, 0, y0, c.width, y1 - y0, 0, 0, c.width, y1 - y0);
				const r = await recognise(b.toDataURL());
				texts.push(r.text); ms += r.ms; conf += r.conf;
			}
			return { text: texts.join(' ').trim(), conf: conf / Math.max(1, bands.length), ms, bands: bands.length };
		};
		const stats = {}; const perCard = [];
		const bump = (k, hit, ms) => { const s = (stats[k] ??= { hits: 0, n: 0, ms: 0 }); s.n++; s.ms += ms; if (hit) s.hits++; };
		for (const c of cards) {
			const row = { idx: c.idx };
			if (c.name) {
				const p = await recognise(c.name);
				row.paddleName = p.text; row.paddleNameHit = bestName(p.text) >= 0.6; row.paddleNameConf = p.conf;
				row.tessNameHit = bestName(c.tessName) >= 0.6;
				bump('name paddle', row.paddleNameHit, p.ms); bump('name tesseract(page)', row.tessNameHit, 0);
			}
			if (c.bottom) {
				const p = await recogniseLines(c.bottom);
				const num = numOf(p.text);
				row.paddleBottom = p.text; row.paddleBottomHit = num !== '' && expNums.includes(num);
				row.tessBottomHit = numOf(c.tessBottom) !== '' && expNums.includes(numOf(c.tessBottom));
				bump('bottom paddle', row.paddleBottomHit, p.ms); bump('bottom tesseract(page)', row.tessBottomHit, 0);
			}
			perCard.push(row);
		}
		return { stats, perCard };
	}, { expNames, expNums });
	console.log(`\n=== ${basename(file)} (${expNames.length} expected) ===`);
	for (const [k, s] of Object.entries(out.stats)) { console.log(`  ${k.padEnd(24)} ${String(s.hits).padStart(2)}/${s.n}  ${s.ms ? Math.round(s.ms / s.n) + ' ms' : ''}`); const t = (totals[k] ??= { hits: 0, n: 0 }); t.hits += s.hits; t.n += s.n; }
	for (const r of out.perCard) console.log(`  Card ${String(r.idx).padStart(2)} name: ${r.paddleNameHit ? 'OK ' : '   '}"${(r.paddleName ?? '').slice(0, 30)}" (${(r.paddleNameConf ?? 0).toFixed(2)}) | bottom: ${r.paddleBottomHit ? 'OK ' : '   '}"${(r.paddleBottom ?? '').slice(0, 40)}"`);
	dump.push({ file: basename(file), stats: out.stats, perCard: out.perCard });
	await page.close();
}
console.log('\n=== TOTALS ===');
for (const [k, t] of Object.entries(totals)) console.log(`  ${k.padEnd(24)} ${t.hits}/${t.n}`);
const union = (a, b) => { let n = 0, h = 0; for (const f of dump) for (const c of f.perCard) { n++; if (c[a] || c[b]) h++; } return `${h}/${n}`; };
console.log(`union name: ${union('paddleNameHit', 'tessNameHit')}, union bottom: ${union('paddleBottomHit', 'tessBottomHit')}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(dump, null, 1));
await browser.close();
