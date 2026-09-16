// OCR input-size experiment: run each photo through /scan (dev server on
// 127.0.0.1:5173, self-hosted Tesseract under /vendor), then re-OCR every
// name and collector crop at several scales and page-segmentation modes and
// count hits against expectations-real-photos.json / seed-cards.json. Scales
// are relative to the crop the page produced. Prints per-variant hit counts
// (and per-card texts) so the NAME_OCR_SCALE / BOTTOM_OCR_SCALE constants in
// src/routes/scan/+page.svelte can be re-tuned on new photos.
// usage: node scripts/scanner-harness/ocr-scale-experiment.mjs [--json out.json] photos/*.jpg
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const argv = process.argv.slice(2); const jsonIdx = argv.indexOf('--json'); const jsonOut = jsonIdx >= 0 ? argv.splice(jsonIdx, 2)[1] : null; const files = argv; const dump = [];
const expectations = JSON.parse(readFileSync('scripts/scanner-harness/expectations-real-photos.json', 'utf8'));
const seed = JSON.parse(readFileSync('scripts/scanner-harness/seed-cards.json', 'utf8'));
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const totals = {};
for (const file of files) {
	const expNames = expectations[basename(file)] || [];
	const expNums = seed.filter((c) => expNames.includes(c.name)).map((c) => String(c.collector_number).replace(/^0+/, ''));
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await page.goto(`${process.env.HARNESS_URL ?? 'http://localhost:5173'}/scan`, { waitUntil: 'networkidle' });
	await page.getByRole('button', { name: 'Multiple cards' }).click();
	await page.setInputFiles('input[type=file]', file);
	await page.waitForFunction(() => /Scan complete:|No cards detected|Error:/.test(document.querySelector('pre')?.textContent ?? ''), null, { timeout: 600000 });
	const out = await page.evaluate(async ({ expNames, expNums }) => {
		const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
		const bigrams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); m.set(b, (m.get(b) || 0) + 1); } return m; };
		const dice = (a, b) => { a = norm(a); b = norm(b); if (a.length < 2 || b.length < 2) return 0; const A = bigrams(a), B = bigrams(b); let inter = 0; for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0); return (2 * inter) / ((a.length - 1) + (b.length - 1)); };
		const bestName = (t) => Math.max(0, ...expNames.map((n) => dice(t, n)));
		const numOf = (t) => { const f = t.match(/(\d{1,4})\/\d{1,4}/); if (f) return f[1].replace(/^0+/, ''); const r = t.match(/(?:^|\s)[CURML]{1,2}\s*0*(\d{1,4})(?!\d)/i); if (r) return r[1].replace(/^0+/, ''); const p = t.match(/(\d{1,4})\s+\d{2,4}\s*[CURML]?\s*(?:[A-Z0-9]{3,4})/); if (p) return p[1].replace(/^0+/, ''); return ''; };
		const cards = Array.from(document.querySelectorAll('h3')).filter((h) => /^Card \d+/.test(h.innerText.trim())).map((h, i) => {
			const b = h.closest('.rounded-lg');
			const imgs = Array.from(b.querySelectorAll('img')).map((im) => ({ src: im.getAttribute('src'), w: im.naturalWidth, h: im.naturalHeight }));
			const wide = imgs.filter((im) => im.w > im.h * 3);
			return { idx: i + 1, name: wide[0]?.src, bottom: wide[1]?.src };
		});
		const T = await import('/vendor/tesseract/tesseract.esm.min.js');
		const createWorker = T.createWorker || T.default?.createWorker;
		const worker = await createWorker('eng', 1, { workerPath: '/vendor/tesseract/worker.min.js', corePath: '/vendor/tesseract/core', langPath: '/vendor/tesseract/lang', gzip: true });
		const WLN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',-.";
		const WLB = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .*#/&';
		const scaleUrl = async (url, f) => { if (f === 1) return url; const img = new Image(); img.src = url; await img.decode(); const c = document.createElement('canvas'); c.width = Math.round(img.width * f); c.height = Math.round(img.height * f); const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, c.width, c.height); return c.toDataURL(); };
		const nameVariants = [0.25, 0.33, 0.42, 0.5, 0.67, 1.0].map((f) => ({ k: `name psm7 x${f}`, p: { tessedit_pageseg_mode: '7', tessedit_char_whitelist: WLN }, f, kind: 'name' }));
		nameVariants.push({ k: 'name psm13 x0.33', p: { tessedit_pageseg_mode: '13', tessedit_char_whitelist: WLN }, f: 0.33, kind: 'name' });
		const bottomVariants = [0.25, 0.33, 0.42, 0.5, 0.67, 1.0].map((f) => ({ k: `bottom psm6 x${f}`, p: { tessedit_pageseg_mode: '6', tessedit_char_whitelist: WLB }, f, kind: 'bottom' }));
		const stats = {}; const perCard = [];
		for (const c of cards) {
			const row = { idx: c.idx, name: {}, bottom: {} };
			for (const v of [...nameVariants, ...bottomVariants]) {
				const src = v.kind === 'name' ? c.name : c.bottom;
				if (!src) continue;
				await worker.setParameters(v.p);
				const t0 = performance.now();
				const o = await worker.recognize(await scaleUrl(src, v.f));
				const text = (o.data.text || '').replace(/\s+/g, ' ').trim();
				const ms = performance.now() - t0;
				let hit;
				if (v.kind === 'name') { hit = bestName(text) >= 0.6; row.name[v.k] = { hit, text: text.slice(0, 40) }; }
				else { const n = numOf(text); hit = n !== '' && expNums.includes(n); row.bottom[v.k] = { hit, text: text.slice(0, 40), num: n }; }
				const s = (stats[v.k] ??= { hits: 0, n: 0, ms: 0 }); s.n++; s.ms += ms; if (hit) s.hits++;
			}
			perCard.push(row);
		}
		await worker.terminate();
		return { stats, perCard };
	}, { expNames, expNums });
	console.log(`\n=== ${basename(file)} (${expNames.length} expected) ===`);
	for (const [k, s] of Object.entries(out.stats)) { console.log(`  ${k.padEnd(20)} ${String(s.hits).padStart(2)}/${s.n}  ${Math.round(s.ms / s.n)} ms`); const t = (totals[k] ??= { hits: 0, n: 0 }); t.hits += s.hits; t.n += s.n; }
	for (const r of out.perCard) {
		const nm = Object.entries(r.name).map(([k, v]) => `${k.replace('name psm', '').padEnd(8)}${v.hit ? 'OK ' : '   '}${v.text.slice(0, 26)}`).join(' | ');
		const bt = Object.entries(r.bottom).map(([k, v]) => `${k.replace('bottom psm', '').padEnd(8)}${v.hit ? 'OK ' : '   '}${v.text.slice(0, 30)}`).join(' | ');
		console.log(`  Card ${String(r.idx).padStart(2)} N: ${nm}`);
		console.log(`          B: ${bt}`);
	}
	dump.push({ file: basename(file), stats: out.stats, perCard: out.perCard });
	await page.close();
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(dump, null, 1));
console.log('\n=== TOTALS ===');
for (const [k, t] of Object.entries(totals)) console.log(`  ${k.padEnd(20)} ${t.hits}/${t.n}`);
await browser.close();
