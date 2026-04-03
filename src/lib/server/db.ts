import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const dataDir = join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, 'mtg.db');
const sqlite = new Database(dbPath);

sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

export function initDb() {
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
			price_eur_foil REAL
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

		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			google_id TEXT UNIQUE NOT NULL,
			email TEXT NOT NULL,
			name TEXT NOT NULL,
			avatar_url TEXT,
			created_at TEXT
		);

		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			expires_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS collection_cards (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
			card_id TEXT NOT NULL REFERENCES cards(id),
			quantity INTEGER NOT NULL DEFAULT 1,
			condition TEXT DEFAULT 'near_mint',
			foil INTEGER DEFAULT 0,
			purchase_price REAL,
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

		CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
		CREATE INDEX IF NOT EXISTS idx_cards_set_code ON cards(set_code);
		CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards(rarity);
		CREATE INDEX IF NOT EXISTS idx_cards_cmc ON cards(cmc);
		CREATE INDEX IF NOT EXISTS idx_cards_oracle_id ON cards(oracle_id);
		CREATE INDEX IF NOT EXISTS idx_cards_type_line ON cards(type_line);
		CREATE INDEX IF NOT EXISTS idx_collection_cards_card_id ON collection_cards(card_id);
		CREATE INDEX IF NOT EXISTS idx_price_history_card_id ON price_history(card_id);
		CREATE INDEX IF NOT EXISTS idx_price_history_recorded_at ON price_history(recorded_at);

		CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
			card_id,
			name,
			type_line,
			oracle_text
		);
	`);

	// Migrations for existing databases
	try {
		sqlite.exec('ALTER TABLE collection_cards ADD COLUMN purchase_price REAL');
	} catch { /* Column already exists */ }

	try {
		sqlite.exec('ALTER TABLE collection_cards ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE');
	} catch { /* Column already exists */ }

	try {
		sqlite.exec('CREATE INDEX IF NOT EXISTS idx_collection_cards_user_id ON collection_cards(user_id)');
		sqlite.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)');
	} catch { /* Indexes already exist */ }
}

export { sqlite };
