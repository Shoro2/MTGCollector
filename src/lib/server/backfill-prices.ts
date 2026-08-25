/**
 * One-off backfill for gaps in `price_history`.
 *
 * Scryfall keeps its dated bulk files reachable after they stop being current
 * (`default-cards-<YYYYMMDDHHMMSS>.jsonl.gz`), but publishes no index of them,
 * so the exact generation timestamp of each day has to come from somewhere.
 * Our own log has it: every run prints
 *
 *     [price-updater] Downloading bulk data (2026-08-24T09:05:26.753+00:00)...
 *
 * even on days the run later failed. This script harvests those timestamps,
 * fetches each day's file, and writes the snapshots the daily job would have
 * written — same source, same prices, no interpolation.
 *
 * Usage (from the app root, so `data/mtg.db` resolves):
 *
 *   npx tsx src/lib/server/backfill-prices.ts --log /root/.pm2/logs/mtg-collector-out.log
 *   npx tsx src/lib/server/backfill-prices.ts --log <file> --from 2026-07-29 --to 2026-08-24
 *   npx tsx src/lib/server/backfill-prices.ts --stamps 2026-08-01T09:09:42.050+00:00,...
 *   ... --dry-run     resolve and probe URLs, write nothing
 *   ... --keep        keep the downloaded files instead of deleting each after use
 *
 * Safe to re-run: writes go through the UNIQUE(card_id, snapshot_date, language)
 * upsert. It only ever touches `price_history` — current prices in `cards` and
 * every user table are left alone.
 */

import Database from 'better-sqlite3';
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseScryfallBulkStream } from './bulk-stream.js';
import { scryfallFetch } from './scryfall.js';

const dataDir = join(process.cwd(), 'data');
const dbPath = join(dataDir, 'mtg.db');

interface BulkCard {
	id: string;
	lang: string;
	prices?: { eur?: string | null; eur_foil?: string | null; usd?: string | null; usd_foil?: string | null };
}

type Prices = [number | null, number | null, number | null, number | null];

interface Day {
	/** YYYY-MM-DD, UTC — the value written to `snapshot_date`. */
	date: string;
	/** Scryfall's own `updated_at`, written to `recorded_at`. */
	updatedAt: string;
	url: string;
}

function parseArgs(argv: string[]) {
	const get = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	return {
		log: get('log'),
		stamps: get('stamps'),
		from: get('from'),
		to: get('to'),
		dryRun: argv.includes('--dry-run'),
		keep: argv.includes('--keep')
	};
}

/** `2026-08-24T09:05:26.753+00:00` -> `default-cards-20260824090526.jsonl.gz` */
function bulkUrlFor(updatedAt: string): string {
	const m = updatedAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
	if (!m) throw new Error(`Unrecognised timestamp: ${updatedAt}`);
	const stamp = m.slice(1).join('');
	return `https://data.scryfall.io/default-cards/default-cards-${stamp}.jsonl.gz`;
}

function collectDays(opts: ReturnType<typeof parseArgs>): Day[] {
	const raw: string[] = [];

	if (opts.stamps) raw.push(...opts.stamps.split(',').map((s) => s.trim()).filter(Boolean));

	if (opts.log) {
		if (!existsSync(opts.log)) throw new Error(`Log file not found: ${opts.log}`);
		const text = readFileSync(opts.log, 'utf-8');
		for (const line of text.split(/\r?\n/)) {
			const m = line.match(/Downloading bulk data \((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^,)]*)/);
			if (m) raw.push(m[1]);
		}
	}

	// One entry per calendar day; if a day appears more than once keep the
	// earliest stamp, which is the file the failed run would have used.
	const byDate = new Map<string, string>();
	for (const updatedAt of raw) {
		const date = updatedAt.slice(0, 10);
		const existing = byDate.get(date);
		if (!existing || updatedAt < existing) byDate.set(date, updatedAt);
	}

	return [...byDate.entries()]
		.filter(([date]) => (!opts.from || date >= opts.from) && (!opts.to || date <= opts.to))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, updatedAt]) => ({ date, updatedAt, url: bulkUrlFor(updatedAt) }));
}

async function download(url: string, target: string): Promise<number> {
	const response = await scryfallFetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
	if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
	mkdirSync(dataDir, { recursive: true });
	await pipeline(
		Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
		createWriteStream(target)
	);
	return Number(response.headers.get('content-length') ?? 0);
}

function num(v: string | null | undefined): number | null {
	return v ? parseFloat(v) : null;
}

function same(a: Prices, b: Prices): boolean {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (!opts.log && !opts.stamps) {
		console.error('Nothing to do: pass --log <pm2 out.log> and/or --stamps <iso,iso,...>');
		process.exit(2);
	}

	const days = collectDays(opts);
	if (days.length === 0) {
		console.error('No bulk-data timestamps found in the given input/range.');
		process.exit(2);
	}

	console.log(`Resolved ${days.length} day(s): ${days[0].date} .. ${days[days.length - 1].date}`);

	if (opts.dryRun) {
		for (const day of days) {
			const res = await fetch(day.url, { method: 'HEAD' });
			console.log(`  ${day.date}  ${res.status}  ${day.url}`);
		}
		console.log('\nDry run — nothing written.');
		return;
	}

	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('synchronous = NORMAL');
	sqlite.pragma('cache_size = -131072');
	// Deliberately NOT temp_store = MEMORY: the seed query below sorts a slice
	// of a very large price_history and this script often runs beside the live
	// app on the same box.
	sqlite.pragma('temp_store = FILE');

	// The columns and the day-dedup index arrive via migrations 0014/0018, not
	// via SCHEMA_SQL, and the upsert below needs that index as its conflict
	// target. Mirrors the same guard in seed.ts.
	const phCols = (sqlite.prepare('PRAGMA table_info(price_history)').all() as Array<{ name: string }>)
		.map((c) => c.name);
	if (!phCols.includes('snapshot_date')) sqlite.exec('ALTER TABLE price_history ADD COLUMN snapshot_date TEXT');
	if (!phCols.includes('language')) sqlite.exec("ALTER TABLE price_history ADD COLUMN language TEXT DEFAULT 'en' NOT NULL");
	sqlite.exec(
		'CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_card_snapshot_lang ON price_history(card_id, snapshot_date, language)'
	);

	// Seed the change-aware comparison from the last snapshot at or before the
	// first day we are about to write, so the backfill continues the existing
	// series instead of restating prices that were already recorded.
	const firstDate = days[0].date;
	console.log(`Seeding baseline from snapshots on or before ${firstDate}...`);
	const baseline = new Map<string, Prices>();
	const seedRows = sqlite
		.prepare(
			`SELECT ph.card_id, ph.price_eur, ph.price_eur_foil, ph.price_usd, ph.price_usd_foil
			   FROM (SELECT card_id, MAX(snapshot_date) AS snapshot_date
			           FROM price_history
			          WHERE language = 'en' AND snapshot_date <= ?
			       GROUP BY card_id) d
			   JOIN price_history ph
			     ON ph.card_id = d.card_id
			    AND ph.language = 'en'
			    AND ph.snapshot_date = d.snapshot_date`
		)
		.all(firstDate) as Array<{
		card_id: string;
		price_eur: number | null;
		price_eur_foil: number | null;
		price_usd: number | null;
		price_usd_foil: number | null;
	}>;
	for (const r of seedRows) {
		baseline.set(r.card_id, [r.price_eur, r.price_eur_foil, r.price_usd, r.price_usd_foil]);
	}
	console.log(`  baseline holds ${baseline.size} cards`);

	const insert = sqlite.prepare(
		`INSERT INTO price_history (card_id, language, price_eur, price_eur_foil, price_usd, price_usd_foil, recorded_at, snapshot_date)
		 VALUES (?, 'en', ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(card_id, snapshot_date, language) DO UPDATE SET
		   price_eur = excluded.price_eur,
		   price_eur_foil = excluded.price_eur_foil,
		   price_usd = excluded.price_usd,
		   price_usd_foil = excluded.price_usd_foil,
		   recorded_at = excluded.recorded_at`
	);
	const cardExists = sqlite.prepare('SELECT 1 FROM cards WHERE id = ?');
	const knownCard = new Set<string>();

	let totalWritten = 0;

	for (const [i, day] of days.entries()) {
		const target = join(dataDir, `scryfall-backfill-${day.date}.jsonl.gz`);
		console.log(`\n[${i + 1}/${days.length}] ${day.date}  (${day.updatedAt})`);

		try {
			const bytes = await download(day.url, target);
			console.log(`  downloaded ${Math.round(bytes / 1024 / 1024)} MB`);

			let scanned = 0;
			let written = 0;
			let skippedUnknown = 0;
			let pending: Array<[string, Prices]> = [];

			const flush = () => {
				const batch = pending;
				pending = [];
				sqlite.transaction(() => {
					for (const [cardId, p] of batch) {
						insert.run(cardId, p[0], p[1], p[2], p[3], day.updatedAt, day.date);
						baseline.set(cardId, p);
						written++;
					}
				})();
			};

			for await (const card of parseScryfallBulkStream<BulkCard>(target)) {
				if (card.lang !== 'en') continue;
				scanned++;

				const p: Prices = [
					num(card.prices?.eur),
					num(card.prices?.eur_foil),
					num(card.prices?.usd),
					num(card.prices?.usd_foil)
				];
				if (p[0] === null && p[1] === null && p[2] === null && p[3] === null) continue;

				const prev = baseline.get(card.id);
				if (prev && same(prev, p)) continue;

				// price_history.card_id references cards(id); a printing that did
				// not exist yet back then would violate the FK.
				if (!knownCard.has(card.id)) {
					if (!cardExists.get(card.id)) {
						skippedUnknown++;
						continue;
					}
					knownCard.add(card.id);
				}

				pending.push([card.id, p]);
				if (pending.length >= 5000) flush();
			}
			if (pending.length > 0) flush();

			totalWritten += written;
			const unknownNote = skippedUnknown > 0 ? `, ${skippedUnknown} not in cards` : '';
			console.log(`  scanned ${scanned} en cards -> wrote ${written} changed rows${unknownNote}`);
		} catch (err) {
			console.error(`  FAILED for ${day.date}:`, (err as Error).message);
		} finally {
			if (!opts.keep && existsSync(target)) unlinkSync(target);
		}
	}

	console.log(`\nDone. Wrote ${totalWritten} price_history rows across ${days.length} day(s).`);

	const check = sqlite
		.prepare(
			`SELECT snapshot_date, COUNT(*) AS n FROM price_history
			  WHERE snapshot_date BETWEEN ? AND ?
			  GROUP BY snapshot_date ORDER BY snapshot_date`
		)
		.all(days[0].date, days[days.length - 1].date) as Array<{ snapshot_date: string; n: number }>;
	console.log('\nCoverage after backfill:');
	for (const row of check) console.log(`  ${row.snapshot_date}  ${row.n}`);

	sqlite.pragma('wal_checkpoint(TRUNCATE)');
	sqlite.close();
}

main().catch((err) => {
	console.error('Backfill failed:', err);
	process.exit(1);
});
