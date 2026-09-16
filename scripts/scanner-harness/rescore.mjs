// Re-score a harness results file (--out of harness.mjs) against an expectations
// file without re-running the scan — e.g. after correcting a ground-truth entry.
// usage: node rescore.mjs results.json expectations.json [--write-baseline baseline.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { scorePhoto } from './score.mjs';
const args = process.argv.slice(2);
const writeBaselinePath = args.includes('--write-baseline') ? args[args.indexOf('--write-baseline') + 1] : null;
const [resultsPath, expectPath] = args.filter((a, i) => a !== '--write-baseline' && args[i - 1] !== '--write-baseline');
const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
const expectations = JSON.parse(readFileSync(expectPath, 'utf8'));
const metricsByFile = {};
for (const r of results) {
	const expected = expectations[r.file];
	if (!expected) continue;
	const score = scorePhoto(r.cards, expected);
	metricsByFile[r.file] = { ...score.metrics, wallSeconds: r.wallSeconds };
	const m = score.metrics;
	console.log(`=== ${r.file}: identity ${m.identity}/${expected.length}, printing ${m.printing}/${expected.length}` + (m.unresolvedPrinting ? `, ${m.unresolvedPrinting} unresolved printing` : '') + (m.likely ? `, ${m.likely} likely` : '') + (m.conflict ? `, ${m.conflict} conflict` : '') + ` — ${r.wallSeconds}s`);
	if (score.wrong.length) console.log('  WRONG:', score.wrong.join(' | '));
	if (score.missing.length) console.log('  MISSING:', score.missing.join(' | '));
}
const files = Object.keys(metricsByFile);
const sum = (k) => files.reduce((a, f) => a + (metricsByFile[f][k] ?? 0), 0);
const expectedTotal = files.reduce((a, f) => a + expectations[f].length, 0);
console.log(`\nTOTAL identity ${sum('identity')}/${expectedTotal}, printing ${sum('printing')}/${expectedTotal}, unresolved printing ${sum('unresolvedPrinting')}, likely ${sum('likely')}, conflict ${sum('conflict')}, wrong identity ${sum('wrongIdentity')}, wrong printing ${sum('wrongPrinting')}, missing ${sum('missing')}, extra ${sum('extra')}, ${sum('wallSeconds').toFixed(1)}s`);
if (writeBaselinePath) {
	writeFileSync(writeBaselinePath, JSON.stringify({ written: new Date().toISOString(), photos: metricsByFile }, null, 1) + '\n');
	console.log(`baseline written to ${writeBaselinePath}`);
}
