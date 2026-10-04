// Usage (Node 22.22+): node scripts/prices-admin-benchmark.mjs --db data/mtg.db
// Optional --baseline path/to/old/cache.ts measures the previous profit query.
// Optional --index-db data/new-scratch.db benchmarks the index on a disposable
// two-column copy of the history. The source connection always stays read-only.
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { getPriceData } from '../src/lib/server/price-data.ts';
import { recentSnapshots, priceHistoryRange, SNAPSHOT_INDEX_SQL } from '../src/lib/server/admin-stats.ts';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const path = option('--db');
if (!path) throw new Error('--db is required');
const db = new Database(path, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
const measure = (name, fn, summarize = value => value) => {
	const start = performance.now();
	const value = fn();
	console.log(JSON.stringify({ name, ms: +(performance.now() - start).toFixed(1), result: summarize(value) }));
	return value;
};
const user = db.prepare(`SELECT user_id FROM collection_cards WHERE user_id IS NOT NULL
	GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1`).get()?.user_id;
let rate = 0.92;
try { rate = JSON.parse(readFileSync('data/exchange-rate.json', 'utf8')).rate; } catch {}
const baseline = option('--baseline');
if (baseline && user) {
	const source = readFileSync(baseline, 'utf8');
	const query = source.slice(source.indexOf('const profitHistory = sqlite')).match(/\.prepare\(\s*`([\s\S]*?)`\s*\)/)?.[1];
	if (!query) throw new Error('No baseline profit query found');
	measure('previousProfitHistory', () => db.prepare(query).all(user, rate, rate, rate, rate), rows => ({ days: rows.length, last: rows.at(-1) }));
}
if (user) measure('newEntirePricePayload', () => getPriceData(db, user, rate), data => ({
	stats: data.stats, missingCostCopies: data.missingPriceCount, missingMarketCopies: data.missingMarketCount,
	days: data.profitHistory.length, last: data.profitHistory.at(-1)
}));
measure('historyRange', () => priceHistoryRange(db));

const scratchPath = option('--index-db');
if (scratchPath) {
	if (existsSync(scratchPath)) throw new Error('Use a new scratch database path; existing files are never overwritten');
	const scratch = new Database(scratchPath);
	try {
		scratch.exec('CREATE TABLE price_history(card_id TEXT, snapshot_date TEXT)');
		const insert = scratch.prepare('INSERT INTO price_history VALUES (?, ?)');
		measure('copyHistoryKeys', () => scratch.transaction(() => {
			for (const row of db.prepare('SELECT card_id, snapshot_date FROM price_history').iterate()) insert.run(row.card_id, row.snapshot_date);
		})(), () => 'copied');
		scratch.exec('CREATE INDEX baseline_card_date ON price_history(card_id, snapshot_date)');
		const before = measure('adminWithoutDateIndex', () => recentSnapshots(scratch));
		measure('buildDateIndex', () => scratch.exec(SNAPSHOT_INDEX_SQL), () => 'created');
		const after = measure('adminWithDateIndex', () => recentSnapshots(scratch));
		if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Index changed the results');
		console.log(JSON.stringify({ name: 'indexResult', identical: true, bytes: scratch.prepare('PRAGMA page_count').get().page_count * scratch.prepare('PRAGMA page_size').get().page_size }));
	} finally { scratch.close(); }
}
db.close();
