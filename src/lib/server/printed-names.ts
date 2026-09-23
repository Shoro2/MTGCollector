/**
 * Names printed on non-English printings, for the scanner's name search: a
 * German card shows "Kriegshorn", the catalogue knows "War Horn". Scryfall's
 * default-cards bulk (the catalogue) holds English printings only; the
 * all-cards bulk (~400 MB gzipped, ~2.4 GB of JSON) has every printing in
 * every language with its `printed_name`. The job downloads it once, keeps
 * the distinct (English name, language, printed name) triples of the wanted
 * languages in `card_names` and throws the file away. German alone is about
 * 30k names.
 *
 * Not scheduled: new sets bring new printed names, so the job is run again
 * after a set release (it replaces the languages it imports). `--export` /
 * `--import` move the table between databases as a small JSON file.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sqlite } from './db.js';
import { parseScryfallBulkStream } from './bulk-stream.js';
import { downloadBulkFile, fetchBulkMeta } from './scryfall.js';
import { printedNameRows, type BulkCard, type PrintedNameRow } from './printed-name-index.js';

export const DEFAULT_LANGS = ['de'];
const dataDir = join(process.cwd(), 'data');
const TEMP_PREFIX = 'scryfall-all-cards-temp-';

/** Remove downloads of runs that were killed before their cleanup (each ~400 MB). */
function sweepTempFiles(): void {
	try {
		for (const name of readdirSync(dataDir)) if (name.startsWith(TEMP_PREFIX)) unlinkSync(join(dataDir, name));
	} catch { /* no data dir yet */ }
}

/** Replace the printed names of the given languages with `rows` in one transaction. */
function storeRows(langs: string[], rows: PrintedNameRow[]): void {
	const del = sqlite.prepare('DELETE FROM card_names WHERE lang = ?');
	const ins = sqlite.prepare('INSERT OR IGNORE INTO card_names (name, lang, printed_name) VALUES (?, ?, ?)');
	sqlite.transaction(() => {
		for (const lang of langs) del.run(lang);
		for (const r of rows) ins.run(r.name, r.lang, r.printed);
	})();
}

/**
 * Download the all-cards bulk file and import the printed names of `langs`.
 * Only names of cards the catalogue knows are kept (the canonical English
 * name must exist in `cards`), so the table never points at nothing.
 */
export async function importPrintedNamesFromScryfall(opts: { langs?: string[]; log?: (line: string) => void } = {}): Promise<{ rows: number; names: number; cards: number }> {
	const langs = (opts.langs ?? DEFAULT_LANGS).map((l) => l.trim().toLowerCase()).filter(Boolean);
	const log = opts.log ?? (() => {});
	const wanted = new Set(langs);
	const known = new Set((sqlite.prepare("SELECT DISTINCT name FROM cards WHERE layout <> 'art_series'").all() as Array<{ name: string }>).map((r) => r.name));

	sweepTempFiles();
	const meta = await fetchBulkMeta('all_cards', { signal: AbortSignal.timeout(60_000) });
	const target = join(dataDir, `${TEMP_PREFIX}${Date.now()}.jsonl.gz`);
	log(`downloading all_cards (${meta.updatedAt}${meta.downloadSize ? `, ~${Math.round(meta.downloadSize / 1024 / 1024)} MB` : ''})`);
	try {
		const bytes = await downloadBulkFile(meta.downloadUri, target, { stallMs: 2 * 60_000, maxMs: 60 * 60_000 });
		log(`download complete (${Math.round(bytes / 1024 / 1024)} MB), reading printed names of ${langs.join(', ')}`);
		const seen = new Set<string>();
		const rows: PrintedNameRow[] = [];
		let cards = 0;
		let unknown = 0;
		for await (const card of parseScryfallBulkStream<BulkCard>(target)) {
			cards++;
			for (const r of printedNameRows(card, wanted)) {
				if (!known.has(r.name)) {
					unknown++;
					continue;
				}
				const key = `${r.lang}\u0000${r.printed}\u0000${r.name}`;
				if (seen.has(key)) continue;
				seen.add(key);
				rows.push(r);
			}
			if (cards % 100_000 === 0) log(`${cards} card objects read, ${rows.length} printed names so far`);
		}
		storeRows(langs, rows);
		const names = new Set(rows.map((r) => r.name)).size;
		log(`stored ${rows.length} printed names for ${names} cards (${cards} card objects read${unknown ? `, ${unknown} names of cards not in the catalogue skipped` : ''})`);
		return { rows: rows.length, names, cards };
	} finally {
		if (existsSync(target)) unlinkSync(target);
	}
}

/** Row counts per language. */
export function printedNamesStatus(): Array<{ lang: string; rows: number; names: number }> {
	return sqlite
		.prepare('SELECT lang, COUNT(*) AS rows, COUNT(DISTINCT name) AS names FROM card_names GROUP BY lang ORDER BY lang')
		.all() as Array<{ lang: string; rows: number; names: number }>;
}

/** Every printed name, e.g. to build the search index. */
export function allPrintedNames(): PrintedNameRow[] {
	return (sqlite.prepare('SELECT name, lang, printed_name FROM card_names').all() as Array<{ name: string; lang: string; printed_name: string }>).map((r) => ({
		name: r.name,
		lang: r.lang,
		printed: r.printed_name
	}));
}

/** Write the table as JSON ({ langs, rows: [name, lang, printed][] }). */
export function exportPrintedNames(path: string): { rows: number } {
	const rows = allPrintedNames();
	const langs = [...new Set(rows.map((r) => r.lang))].sort();
	writeFileSync(path, JSON.stringify({ langs, rows: rows.map((r) => [r.name, r.lang, r.printed]) }));
	return { rows: rows.length };
}

/** Load an export, replacing the languages it contains; names the catalogue does not know are skipped. */
export function importPrintedNames(path: string): { rows: number; skipped: number } {
	const data = JSON.parse(readFileSync(path, 'utf-8')) as { langs: string[]; rows: Array<[string, string, string]> };
	const known = new Set((sqlite.prepare('SELECT DISTINCT name FROM cards').all() as Array<{ name: string }>).map((r) => r.name));
	const rows: PrintedNameRow[] = [];
	let skipped = 0;
	for (const [name, lang, printed] of data.rows) {
		if (!known.has(name)) {
			skipped++;
			continue;
		}
		rows.push({ name, lang, printed });
	}
	storeRows(data.langs, rows);
	return { rows: rows.length, skipped };
}
