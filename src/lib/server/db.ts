import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { SCHEMA_SQL } from './schema-sql.js';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const dataDir = join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, 'mtg.db');
const sqlite = new Database(dbPath);

sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('cache_size = -131072'); // 128MB page cache (default is ~8MB)

export const db = drizzle(sqlite, { schema });

export function initDb() {
	sqlite.exec(SCHEMA_SQL);

	// FTS5 sync triggers for incremental updates
	try {
		sqlite.exec(`
			CREATE TRIGGER IF NOT EXISTS cards_fts_insert AFTER INSERT ON cards BEGIN
				INSERT INTO cards_fts(card_id, name, type_line, oracle_text)
				VALUES (NEW.id, NEW.name, COALESCE(NEW.type_line, ''), COALESCE(NEW.oracle_text, ''));
			END;
		`);
		sqlite.exec(`
			CREATE TRIGGER IF NOT EXISTS cards_fts_update AFTER UPDATE OF name, type_line, oracle_text ON cards BEGIN
				DELETE FROM cards_fts WHERE card_id = OLD.id;
				INSERT INTO cards_fts(card_id, name, type_line, oracle_text)
				VALUES (NEW.id, NEW.name, COALESCE(NEW.type_line, ''), COALESCE(NEW.oracle_text, ''));
			END;
		`);
		sqlite.exec(`
			CREATE TRIGGER IF NOT EXISTS cards_fts_delete AFTER DELETE ON cards BEGIN
				DELETE FROM cards_fts WHERE card_id = OLD.id;
			END;
		`);
	} catch { /* Triggers already exist or SQLite version doesn't support IF NOT EXISTS on triggers */ }

	// Migrations for existing databases
	try {
		sqlite.exec('ALTER TABLE collection_cards ADD COLUMN purchase_price REAL');
	} catch { /* Column already exists */ }

	try {
		sqlite.exec('ALTER TABLE collection_cards ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE');
	} catch { /* Column already exists */ }

	try {
		sqlite.exec('ALTER TABLE cards ADD COLUMN price_usd REAL');
	} catch { /* Column already exists */ }

	try {
		sqlite.exec('ALTER TABLE cards ADD COLUMN price_usd_foil REAL');
	} catch { /* Column already exists */ }

	try {
		sqlite.exec('ALTER TABLE price_history ADD COLUMN price_usd REAL');
	} catch { /* Column already exists */ }

	try {
		sqlite.exec('ALTER TABLE price_history ADD COLUMN price_usd_foil REAL');
	} catch { /* Column already exists */ }

	try {
		sqlite.exec('ALTER TABLE users ADD COLUMN google_vision_api_key TEXT');
	} catch { /* Column already exists */ }

	// API usage tracking
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS api_usage (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			service TEXT NOT NULL,
			endpoint TEXT,
			request_count INTEGER DEFAULT 1,
			image_count INTEGER DEFAULT 0,
			user_id TEXT,
			created_at TEXT DEFAULT (datetime('now'))
		)
	`);

	// Contact form submissions
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS contact_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			email TEXT NOT NULL,
			subject TEXT,
			message TEXT NOT NULL,
			ip_hash TEXT,
			user_agent TEXT,
			handled INTEGER DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now'))
		)
	`);
	sqlite.exec('CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at ON contact_messages(created_at DESC)');
}

export { sqlite };
