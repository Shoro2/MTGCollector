// Drive /scan with image files and report what the pipeline identified.
// usage: node harness.mjs [--mode single|multiple] [--expect expectations.json] [--out results.json] file...
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const args = process.argv.slice(2);
let mode = 'multiple', expectPath = null, outPath = null; const files = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--mode') mode = args[++i];
	else if (args[i] === '--expect') expectPath = args[++i];
	else if (args[i] === '--out') outPath = args[++i];
	else files.push(args[i]);
}
const expectations = expectPath ? JSON.parse(readFileSync(expectPath, 'utf8')) : {};
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const all = [];
for (const file of files) {
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
	await page.goto('http://127.0.0.1:5173/scan', { waitUntil: 'networkidle' });
	await page.getByRole('button', { name: mode === 'single' ? 'Single card' : 'Multiple cards' }).click();
	const t0 = Date.now();
	await page.setInputFiles('input[type=file]', file);
	await page.waitForFunction(() => /Done!|No cards detected|Error:/.test(document.body.innerText), null, { timeout: 900000 });
	const wall = (Date.now() - t0) / 1000;
	const log = await page.evaluate(() => document.querySelector('pre')?.textContent ?? '');
	const cards = await page.evaluate(() => Array.from(document.querySelectorAll('h3')).filter((h) => /^Card \d+/.test(h.innerText.trim())).map((h) => {
		const block = h.closest('.rounded-lg');
		const txt = block.innerText;
		const chosen = block.querySelector('.ring-1 p.font-semibold, p.font-semibold');
		const chosenSet = chosen ? chosen.nextElementSibling?.innerText.trim() : '';
		const mono = Array.from(block.querySelectorAll('p.font-mono')).map((p) => p.innerText.trim());
		return { card: h.innerText.trim().split('\n')[0].replace(/\s+/g, ' '), name: chosen ? chosen.innerText.trim() : null, printing: chosenSet, nameOcr: mono[0] ?? '', bottomOcr: mono[1] ?? '', notIdentified: txt.includes('Not identified automatically'), candidates: block.querySelectorAll('p.font-semibold').length };
	}));
	const summary = (log.match(/Scan complete: (\d+)\/(\d+) identified/) || [null, '?', '?']);
	const phases = {};
	for (const m of log.matchAll(/\[\+([\d.]+)s\] (Detection complete|Phase 1|Phase 2: Name search|Phase 3: Bottom OCR|Scan complete)/g)) phases[m[2]] = Number(m[1]);
	const expected = expectations[basename(file)] || null;
	let matched = null, missing = null, wrong = null;
	if (expected) {
		const got = cards.filter((c) => c.name).map((c) => c.name);
		const pool = [...expected]; matched = 0; wrong = [];
		for (const g of got) { const i = pool.indexOf(g); if (i >= 0) { pool.splice(i, 1); matched++; } else wrong.push(g); }
		missing = pool;
	}
	const result = { file: basename(file), mode, wallSeconds: Number(wall.toFixed(1)), identified: summary[1], detected: summary[2], expectedCount: expected ? expected.length : null, matched, wrong, missing, phases, errors, cards, log };
	all.push(result);
	console.log(`\n=== ${result.file} (${mode}) — ${result.identified}/${result.detected} identified` + (expected ? `, ${matched}/${expected.length} expected names matched` : '') + ` — ${result.wallSeconds}s ===`);
	console.log('phases:', JSON.stringify(phases));
	for (const c of cards) console.log(`  ${c.card.padEnd(14)} ${(c.name ?? '—').padEnd(34)} ${(c.printing ?? '').padEnd(40)} name-ocr="${c.nameOcr.slice(0, 40)}" bottom-ocr="${c.bottomOcr.slice(0, 50)}"`);
	if (wrong?.length) console.log('  WRONG:', wrong.join(' | '));
	if (missing?.length) console.log('  MISSING:', missing.join(' | '));
	if (errors.length) console.log('  page errors:', errors.slice(0, 3));
	await page.close();
}
if (outPath) writeFileSync(outPath, JSON.stringify(all, null, 1));
await browser.close();
