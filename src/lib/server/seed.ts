import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, createWriteStream, existsSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { SCHEMA_SQL } from './schema-sql.js';
import { parseScryfallBulkStream } from './bulk-stream.js';

const dataDir = join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, 'mtg.db');
const bulkDataPath = join(dataDir, 'scryfall-default-cards.json');

interface ScryfallCard {
	id: string;
	oracle_id?: string;
	name: string;
	mana_cost?: string;
	cmc?: number;
	type_line?: string;
	oracle_text?: string;
	colors?: string[];
	color_identity?: string[];
	keywords?: string[];
	set: string;
	set_name: string;
	collector_number: string;
	rarity: string;
	power?: string;
	toughness?: string;
	loyalty?: string;
	image_uris?: { normal?: string; small?: string; large?: string };
	layout: string;
	legalities?: Record<string, string>;
	released_at?: string;
	scryfall_uri?: string;
	prices?: { eur?: string | null; eur_foil?: string | null; usd?: string | null; usd_foil?: string | null };
	lang: string;
	card_faces?: Array<{
		name?: string;
		mana_cost?: string;
		type_line?: string;
		oracle_text?: string;
		image_uris?: { normal?: string };
		power?: string;
		toughness?: string;
	}>;
}

async function downloadBulkData(): Promise<string> {
	console.log('Fetching Scryfall bulk data catalog...');
	const response = await fetch('https://api.scryfall.com/bulk-data');
	const data = await response.json();

	const defaultCards = data.data.find((d: { type: string }) => d.type === 'default_cards');
	if (!defaultCards) throw new Error('Could not find default_cards bulk data');

	const downloadUri: string = defaultCards.download_uri;
	console.log(`Downloading bulk data from ${downloadUri}...`);
	console.log(`Expected size: ~${Math.round(defaultCards.size / 1024 / 1024)}MB`);

	const downloadResponse = await fetch(downloadUri);
	if (!downloadResponse.ok || !downloadResponse.body) {
		throw new Error(`Download failed: ${downloadResponse.status}`);
	}

	const fileStream = createWriteStream(bulkDataPath);
	// @ts-expect-error Node.js ReadableStream compatibility
	await pipeline(downloadResponse.body, fileStream);

	console.log('Download complete.');
	return bulkDataPath;
}

async function importCards(filePath: string) {
	console.log('Opening database...');
	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('synchronous = OFF'); // Bulk import: durability traded for speed
	sqlite.pragma('cache_size = -131072');
	sqlite.pragma('temp_store = MEMORY');

	sqlite.exec(SCHEMA_SQL);

	const insertCard = sqlite.prepare(`
		INSERT OR REPLACE INTO cards (
			id, oracle_id, name, mana_cost, cmc, type_line, oracle_text,
			colors, color_identity, keywords, set_code, set_name,
			collector_number, rarity, power, toughness, loyalty,
			image_uri, layout, legalities, released_at, scryfall_uri,
			price_eur, price_eur_foil, price_usd, price_usd_foil
		) VALUES (
			?, ?, ?, ?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?, ?,
			?, ?, ?, ?
		)
	`);

	const insertFace = sqlite.prepare(`
		INSERT OR REPLACE INTO card_faces (
			card_id, face_index, name, mana_cost, type_line, oracle_text,
			image_uri, power, toughness
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const insertPrice = sqlite.prepare(`
		INSERT INTO price_history (card_id, price_eur, price_eur_foil, price_usd, price_usd_foil, recorded_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`);

	sqlite.exec('DELETE FROM card_faces');

	const now = new Date().toISOString();
	const batchSize = 5000;
	let imported = 0;
	let pendingBatch: ScryfallCard[] = [];

	const applyBatch = () => {
		const batch = pendingBatch;
		pendingBatch = [];
		const transaction = sqlite.transaction(() => {
			for (const card of batch) {
				const imageUri =
					card.image_uris?.normal ||
					card.card_faces?.[0]?.image_uris?.normal ||
					null;

				const priceEur = card.prices?.eur ? parseFloat(card.prices.eur) : null;
				const priceEurFoil = card.prices?.eur_foil
					? parseFloat(card.prices.eur_foil)
					: null;
				const priceUsd = card.prices?.usd ? parseFloat(card.prices.usd) : null;
				const priceUsdFoil = card.prices?.usd_foil
					? parseFloat(card.prices.usd_foil)
					: null;

				insertCard.run(
					card.id,
					card.oracle_id || null,
					card.name,
					card.mana_cost || null,
					card.cmc ?? null,
					card.type_line || null,
					card.oracle_text || null,
					card.colors ? JSON.stringify(card.colors) : null,
					card.color_identity ? JSON.stringify(card.color_identity) : null,
					card.keywords ? JSON.stringify(card.keywords) : null,
					card.set,
					card.set_name,
					card.collector_number,
					card.rarity,
					card.power || null,
					card.toughness || null,
					card.loyalty || null,
					imageUri,
					card.layout,
					card.legalities ? JSON.stringify(card.legalities) : null,
					card.released_at || null,
					card.scryfall_uri || null,
					priceEur,
					priceEurFoil,
					priceUsd,
					priceUsdFoil
				);

				if (card.card_faces && card.card_faces.length > 1) {
					for (let fi = 0; fi < card.card_faces.length; fi++) {
						const face = card.card_faces[fi];
						insertFace.run(
							card.id,
							fi,
							face.name || null,
							face.mana_cost || null,
							face.type_line || null,
							face.oracle_text || null,
							face.image_uris?.normal || null,
							face.power || null,
							face.toughness || null
						);
					}
				}

				if (priceEur !== null || priceEurFoil !== null || priceUsd !== null || priceUsdFoil !== null) {
					insertPrice.run(card.id, priceEur, priceEurFoil, priceUsd, priceUsdFoil, now);
				}
			}
		});
		transaction();
	};

	console.log('Streaming JSON and importing cards (English only)...');
	for await (const card of parseScryfallBulkStream<ScryfallCard>(filePath)) {
		if (card.lang !== 'en') continue;
		pendingBatch.push(card);
		if (pendingBatch.length >= batchSize) {
			applyBatch();
			imported += batchSize;
			process.stdout.write(`\rImported ${imported} cards...`);
		}
	}
	if (pendingBatch.length > 0) {
		imported += pendingBatch.length;
		applyBatch();
	}

	console.log('\nBuilding full-text search index...');
	// External-content FTS5: rebuild reads directly from cards by rowid.
	sqlite.exec(`INSERT INTO cards_fts(cards_fts) VALUES('rebuild')`);

	// Collapse same-day duplicates (initial seed writes one snapshot per card;
	// re-seeding on an existing DB would otherwise create a second row).
	sqlite.exec(`
		DELETE FROM price_history
		WHERE id NOT IN (
			SELECT MAX(id) FROM price_history
			GROUP BY card_id, DATE(recorded_at)
		)
	`);
	sqlite.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_card_day ON price_history(card_id, DATE(recorded_at))`
	);

	const count = sqlite.prepare('SELECT COUNT(*) as count FROM cards').get() as { count: number };
	console.log(`Done! ${count.count} cards in database.`);

	sqlite.close();
}

async function main() {
	const args = process.argv.slice(2);
	const skipDownload = args.includes('--skip-download');

	if (!skipDownload || !existsSync(bulkDataPath)) {
		await downloadBulkData();
	} else {
		console.log('Using existing bulk data file.');
	}

	await importCards(bulkDataPath);

	if (args.includes('--cleanup') && existsSync(bulkDataPath)) {
		unlinkSync(bulkDataPath);
		console.log('Cleaned up bulk data file.');
	}
}

main().catch((err) => {
	console.error('Import failed:', err);
	process.exit(1);
});
