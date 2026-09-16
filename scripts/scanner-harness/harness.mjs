// Drive /scan with image files and report what the pipeline identified.
// usage: node harness.mjs [--mode single|multiple] [--expect expectations.json]
//                         [--baseline baseline.json] [--write-baseline baseline.json]
//                         [--out results.json] file...
//
// Expectations map a file name to its card instances, either as printings
// `{ "name", "set", "number" }` (the metric then covers the printing) or as
// plain names (identity only). Metrics per photo:
//   detected            card quads the pipeline produced
//   identity            cards whose accepted name matches an expected instance
//   printing            identity matches whose unique set + number is the expected one
//   unresolvedPrinting  identity matches with several candidate printings left
//   wrongIdentity       accepted names that match no expected instance
//   wrongPrinting       identity matches whose unique printing differs from the expected one
//   missing             expected instances no card was matched to
//   extra               detected quads beyond the expected instance count
//   likely              cards the pipeline offers for one-tap confirmation (not counted as identified)
// `--baseline` compares identity/printing (must not drop) and wrongIdentity/
// wrongPrinting (must not rise) per photo and exits 1 on a regression;
// `--write-baseline` stores the current metrics.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { scorePhoto } from './score.mjs';
const args = process.argv.slice(2);
let mode = 'multiple', expectPath = null, outPath = null, baselinePath = null, writeBaselinePath = null; const files = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--mode') mode = args[++i];
	else if (args[i] === '--expect') expectPath = args[++i];
	else if (args[i] === '--out') outPath = args[++i];
	else if (args[i] === '--baseline') baselinePath = args[++i];
	else if (args[i] === '--write-baseline') writeBaselinePath = args[++i];
	else files.push(args[i]);
}
const expectations = expectPath ? JSON.parse(readFileSync(expectPath, 'utf8')) : {};
const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const all = [];
const metricsByFile = {};

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
		const state = block.dataset.state ?? (chosen ? 'confirmed' : 'unknown');
		return { card: h.innerText.trim().split('\n')[0].replace(/\s+/g, ' '), name: chosen ? chosen.innerText.trim() : null, printing: chosenSet, state, printingState: block.dataset.printingState ?? '', finish: block.dataset.finish ?? '', nameOcr: mono[0] ?? '', bottomOcr: mono[1] ?? '', notIdentified: txt.includes('Not identified automatically'), candidates: block.querySelectorAll('p.font-semibold').length };
	}));
	const summary = (log.match(/Scan complete: (\d+)\/(\d+) identified/) || [null, '?', '?']);
	const phases = {};
	for (const m of log.matchAll(/\[\+([\d.]+)s\] (Detection complete|Phase 1|Phase 2: Name search|Phase 3: Bottom OCR|Scan complete)/g)) phases[m[2]] = Number(m[1]);
	const expected = expectations[basename(file)] || null;
	const score = expected ? scorePhoto(cards, expected) : null;
	const result = { file: basename(file), mode, wallSeconds: Number(wall.toFixed(1)), identified: summary[1], detected: summary[2], expectedCount: expected ? expected.length : null, metrics: score?.metrics ?? null, matched: score?.metrics.identity ?? null, wrong: score?.wrong ?? null, missing: score?.missing ?? null, phases, errors, cards, log };
	all.push(result);
	if (score) metricsByFile[result.file] = { ...score.metrics, wallSeconds: result.wallSeconds };
	console.log(`\n=== ${result.file} (${mode}) — ${result.identified}/${result.detected} identified` + (score ? `, identity ${score.metrics.identity}/${expected.length}, printing ${score.metrics.printing}/${expected.length}` + (score.metrics.unresolvedPrinting ? `, ${score.metrics.unresolvedPrinting} unresolved printing` : '') + (score.metrics.likely ? `, ${score.metrics.likely} likely` : '') : '') + ` — ${result.wallSeconds}s ===`);
	console.log('phases:', JSON.stringify(phases));
	for (const c of cards) console.log(`  ${c.card.padEnd(14)} ${(c.name ?? '—').padEnd(34)} ${(c.printing ?? '').padEnd(40)} [${c.state}] name-ocr="${c.nameOcr.slice(0, 40)}" bottom-ocr="${c.bottomOcr.slice(0, 50)}"`);
	if (score?.wrong.length) console.log('  WRONG:', score.wrong.join(' | '));
	if (score?.missing.length) console.log('  MISSING:', score.missing.join(' | '));
	if (errors.length) console.log('  page errors:', errors.slice(0, 3));
	await page.close();
}
if (outPath) writeFileSync(outPath, JSON.stringify(all, null, 1));
await browser.close();

// Totals and baseline comparison.
const files2 = Object.keys(metricsByFile);
if (files2.length > 0) {
	const sum = (k) => files2.reduce((a, f) => a + metricsByFile[f][k], 0);
	const expectedTotal = files2.reduce((a, f) => a + (expectations[f]?.length ?? 0), 0);
	console.log(`\nTOTAL identity ${sum('identity')}/${expectedTotal}, printing ${sum('printing')}/${expectedTotal}, unresolved printing ${sum('unresolvedPrinting')}, likely ${sum('likely')}, wrong identity ${sum('wrongIdentity')}, wrong printing ${sum('wrongPrinting')}, missing ${sum('missing')}, extra ${sum('extra')}, ${sum('wallSeconds').toFixed(1)}s`);
	if (writeBaselinePath) {
		writeFileSync(writeBaselinePath, JSON.stringify({ written: new Date().toISOString(), photos: metricsByFile }, null, 1) + '\n');
		console.log(`baseline written to ${writeBaselinePath}`);
	}
	if (baseline) {
		const regressions = [];
		for (const f of files2) {
			const b = baseline.photos?.[f];
			if (!b) continue;
			const m = metricsByFile[f];
			for (const k of ['identity', 'printing']) if (m[k] < b[k]) regressions.push(`${f}: ${k} ${b[k]} -> ${m[k]}`);
			for (const k of ['wrongIdentity', 'wrongPrinting']) if (m[k] > b[k]) regressions.push(`${f}: ${k} ${b[k]} -> ${m[k]}`);
		}
		if (regressions.length > 0) {
			console.log('\nREGRESSIONS against baseline:\n  ' + regressions.join('\n  '));
			process.exit(1);
		}
		console.log('\nno regressions against baseline');
	}
}
