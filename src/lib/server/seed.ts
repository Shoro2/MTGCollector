import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, createWriteStream, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';

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

function importCards(filePath: string) {
	console.log('Opening database...');
	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('synchronous = OFF');
	sqlite.pragma('cache_size = -64000');

	// Create tables
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS cards (
			id TEXT PRIMARY KEY,
			oracle_id TEXT,
			name TEXT NOT NULL,
			mana_cost TEXT,
			cmc REAL,
			type_line TEXT,
			oracle_text TEXT,
			colors TEXT,
			color_identity TEXT,
			keywords TEXT,
			set_code TEXT,
			set_name TEXT,
			collector_number TEXT,
			rarity TEXT,
			power TEXT,
			toughness TEXT,
			loyalty TEXT,
			image_uri TEXT,
			local_image_path TEXT,
			layout TEXT,
			legalities TEXT,
			released_at TEXT,
			scryfall_uri TEXT,
			price_eur REAL,
			price_eur_foil REAL,
			price_usd REAL,
			price_usd_foil REAL
		);

		CREATE TABLE IF NOT EXISTS card_faces (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			card_id TEXT NOT NULL REFERENCES cards(id),
			face_index INTEGER NOT NULL,
			name TEXT,
			mana_cost TEXT,
			type_line TEXT,
			oracle_text TEXT,
			image_uri TEXT,
			power TEXT,
			toughness TEXT
		);

		CREATE TABLE IF NOT EXISTS collection_cards (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			card_id TEXT NOT NULL REFERENCES cards(id),
			quantity INTEGER NOT NULL DEFAULT 1,
			condition TEXT DEFAULT 'near_mint',
			foil INTEGER DEFAULT 0,
			notes TEXT,
			added_at TEXT
		);

		CREATE TABLE IF NOT EXISTS tags (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			color TEXT DEFAULT '#3b82f6'
		);

		CREATE TABLE IF NOT EXISTS collection_card_tags (
			collection_card_id INTEGER NOT NULL REFERENCES collection_cards(id) ON DELETE CASCADE,
			tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
			PRIMARY KEY (collection_card_id, tag_id)
		);

		CREATE TABLE IF NOT EXISTS price_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			card_id TEXT NOT NULL REFERENCES cards(id),
			price_eur REAL,
			price_eur_foil REAL,
			recorded_at TEXT
		);
	`);

	console.log('Reading JSON file...');
	// Read and parse in chunks - the file can be very large
	const fileContent = readFileSync(filePath, 'utf-8');
	const allCards: ScryfallCard[] = JSON.parse(fileContent);

	// Filter to English cards only
	const englishCards = allCards.filter((c) => c.lang === 'en');
	console.log(`Found ${allCards.length} total cards, ${englishCards.length} English cards`);

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
		INSERT INTO price_history (card_id, price_eur, price_eur_foil, recorded_at)
		VALUES (?, ?, ?, ?)
	`);

	// Delete existing card_faces to avoid duplicates on re-import
	sqlite.exec('DELETE FROM card_faces');

	const now = new Date().toISOString();
	const batchSize = 5000;
	let imported = 0;

	console.log('Importing cards...');

	for (let i = 0; i < englishCards.length; i += batchSize) {
		const batch = englishCards.slice(i, i + batchSize);
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

				// Insert card faces for multi-faced cards
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

				// Record initial price
				if (priceEur !== null || priceEurFoil !== null) {
					insertPrice.run(card.id, priceEur, priceEurFoil, now);
				}
			}
		});
		transaction();
		imported += batch.length;
		const pct = ((imported / englishCards.length) * 100).toFixed(1);
		process.stdout.write(`\rImported ${imported}/${englishCards.length} (${pct}%)`);
	}

	console.log('\nBuilding indexes...');
	sqlite.exec(`
		CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
		CREATE INDEX IF NOT EXISTS idx_cards_set_code ON cards(set_code);
		CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards(rarity);
		CREATE INDEX IF NOT EXISTS idx_cards_cmc ON cards(cmc);
		CREATE INDEX IF NOT EXISTS idx_cards_oracle_id ON cards(oracle_id);
		CREATE INDEX IF NOT EXISTS idx_cards_type_line ON cards(type_line);
		CREATE INDEX IF NOT EXISTS idx_collection_cards_card_id ON collection_cards(card_id);
		CREATE INDEX IF NOT EXISTS idx_price_history_card_id ON price_history(card_id);
		CREATE INDEX IF NOT EXISTS idx_price_history_recorded_at ON price_history(recorded_at);
	`);

	console.log('Building full-text search index...');
	sqlite.exec(`DROP TABLE IF EXISTS cards_fts`);
	sqlite.exec(`
		CREATE VIRTUAL TABLE cards_fts USING fts5(
			card_id,
			name,
			type_line,
			oracle_text
		);
		INSERT INTO cards_fts(card_id, name, type_line, oracle_text)
			SELECT id, name, COALESCE(type_line, ''), COALESCE(oracle_text, '') FROM cards;
	`);

	const count = sqlite.prepare('SELECT COUNT(*) as count FROM cards').get() as { count: number };
	console.log(`\nDone! ${count.count} cards in database.`);

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

	importCards(bulkDataPath);

	// Clean up downloaded file to save space
	if (args.includes('--cleanup') && existsSync(bulkDataPath)) {
		unlinkSync(bulkDataPath);
		console.log('Cleaned up bulk data file.');
	}
}

main().catch((err) => {
	console.error('Import failed:', err);
	process.exit(1);
});
