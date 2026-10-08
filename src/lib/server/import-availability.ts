/** Backfill availability only. Never rewrites prices, names, holdings or artwork hashes. */
import Database from 'better-sqlite3';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { availabilityWriter, ensureAvailabilityColumn } from './card-availability.js';
import { parseScryfallBulkStream } from './bulk-stream.js';
import { downloadBulkFile, fetchDefaultCardsBulkMeta } from './scryfall.js';

let temp: string | undefined;
let downloadedFile: string | undefined;
let db: Database.Database | undefined;
try {
	let file = process.argv[2];
	if (process.argv.length > 3 || file?.startsWith('-')) throw new Error('Usage: npm run import-availability -- [bulk-file.json[.gz]]');
	if (!file) {
		const meta = await fetchDefaultCardsBulkMeta({ signal: AbortSignal.timeout(60_000) });
		temp = await mkdtemp(join(tmpdir(), 'mtg-availability-'));
		file = join(temp, meta.downloadUri.endsWith('.gz') ? 'cards.json.gz' : 'cards.json');
		downloadedFile = file;
		console.log(`Downloading default_cards (${meta.updatedAt}) for availability metadata.`);
		await downloadBulkFile(meta.downloadUri, file, { stallMs: 120_000, maxMs: 45 * 60_000 });
	}
	db = new Database(resolve(process.env.MTG_DB_PATH || 'data/mtg.db'), { fileMustExist: true });
	db.pragma('journal_mode = WAL');
	db.pragma('busy_timeout = 10000');
	ensureAvailabilityColumn(db);
	const write = availabilityWriter(db);
	let batch: Array<{ id: string; games?: unknown }> = [], read = 0, changed = 0;
	const flush = db.transaction(() => { for (const card of batch) changed += write(card); });
	for await (const card of parseScryfallBulkStream<{ id: string; games?: unknown }>(file)) {
		if (typeof card.id !== 'string') continue;
		batch.push(card); read++;
		if (batch.length >= 1000) { flush(); batch = []; }
	}
	flush();
	console.log(JSON.stringify({ read, changed, availability: db.prepare('SELECT is_paper, COUNT(*) AS count FROM cards GROUP BY is_paper').all() }));
	console.log('Restart the application after a standalone backfill to refresh its scanner indexes.');
} finally {
	db?.close();
	if (downloadedFile) await rm(downloadedFile, { force: true });
	if (temp) await rmdir(temp);
}
