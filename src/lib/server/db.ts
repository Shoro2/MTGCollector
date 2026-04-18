import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { SCHEMA_SQL } from './schema-sql.js';
import { runMigrations, type Migration } from './migrations.js';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const dataDir = join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, 'mtg.db');
const sqlite = new Database(dbPath);

// synchronous=NORMAL is safe with WAL (durability vs FULL is "last committed
// transaction may be lost on power loss", not corruption) and roughly halves
// write latency. temp_store=MEMORY keeps sort/temp tables in RAM. mmap_size
// lets SQLite read pages via the OS page cache instead of read() syscalls.
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('cache_size = -131072'); // 128MB page cache
sqlite.pragma('temp_store = MEMORY');
sqlite.pragma('mmap_size = 30000000'); // 30MB

export const db = drizzle(sqlite, { schema });

type DB = typeof sqlite;

function tableColumnNames(db: DB, table: string): Set<string> {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return new Set(rows.map((r) => r.name));
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string) {
	if (tableColumnNames(db, table).has(column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// All migrations are idempotent so that re-running on a partially-upgraded DB
// converges to the target schema. The runner also records each id in
// `_schema_migrations`, so new migrations only execute once.
const MIGRATIONS: Migration[] = [
	{
		id: '0001_collection_cards_purchase_price',
		run: (db) => addColumnIfMissing(db, 'collection_cards', 'purchase_price', 'REAL')
	},
	{
		id: '0002_collection_cards_user_id',
		run: (db) => {
			addColumnIfMissing(db, 'collection_cards', 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');
			db.exec('CREATE INDEX IF NOT EXISTS idx_collection_cards_user_id ON collection_cards(user_id)');
			db.exec('CREATE INDEX IF NOT EXISTS idx_collection_cards_user_card ON collection_cards(user_id, card_id)');
			db.exec('CREATE INDEX IF NOT EXISTS idx_collection_cards_user_added ON collection_cards(user_id, added_at DESC)');
		}
	},
	{
		id: '0003_cards_price_usd',
		run: (db) => {
			addColumnIfMissing(db, 'cards', 'price_usd', 'REAL');
			addColumnIfMissing(db, 'cards', 'price_usd_foil', 'REAL');
		}
	},
	{
		id: '0004_price_history_price_usd',
		run: (db) => {
			addColumnIfMissing(db, 'price_history', 'price_usd', 'REAL');
			addColumnIfMissing(db, 'price_history', 'price_usd_foil', 'REAL');
		}
	},
	{
		id: '0005_users_google_vision_api_key',
		run: (db) => addColumnIfMissing(db, 'users', 'google_vision_api_key', 'TEXT')
	},
	{
		id: '0006_fts_external_content',
		run: (db) => {
			// Old FTS5 schema exposed a `card_id` column and stored its own copy
			// of name/type_line/oracle_text. Replace with an external-content FTS
			// that reads directly from cards via rowid.
			let needsRebuild = false;
			try {
				if (tableColumnNames(db, 'cards_fts').has('card_id')) needsRebuild = true;
			} catch {
				// Virtual tables sometimes don't answer PRAGMA; fall back to probing.
				needsRebuild = true;
			}
			if (!needsRebuild) return;

			db.exec('DROP TABLE IF EXISTS cards_fts');
			db.exec(`
				CREATE VIRTUAL TABLE cards_fts USING fts5(
					name, type_line, oracle_text,
					content='cards',
					content_rowid='rowid'
				)
			`);
			db.exec(`INSERT INTO cards_fts(cards_fts) VALUES('rebuild')`);
		}
	},
	{
		id: '0007_tags_per_user',
		run: (db) => {
			// Old schema had `name TEXT NOT NULL UNIQUE` at column level — auto-
			// indexed and undroppable, so the only way to get (user_id, name)
			// composite uniqueness is to recreate the table.
			if (tableColumnNames(db, 'tags').has('user_id')) return;

			// Pick a default owner for existing (formerly global) tags: prefer
			// ADMIN_EMAIL, fall back to the oldest account. With no users at all
			// (dev scaffold) we drop the orphans and their join rows.
			const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
			const defaultOwner = db
				.prepare(
					`SELECT id FROM users
					 ORDER BY CASE WHEN LOWER(email) = ? THEN 0 ELSE 1 END, created_at ASC
					 LIMIT 1`
				)
				.get(adminEmail) as { id: string } | undefined;

			db.exec(`
				CREATE TABLE tags_new (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
					name TEXT NOT NULL,
					color TEXT DEFAULT '#3b82f6',
					UNIQUE(user_id, name)
				)
			`);

			if (defaultOwner) {
				db.prepare(
					`INSERT INTO tags_new (id, user_id, name, color)
					 SELECT id, ?, name, color FROM tags`
				).run(defaultOwner.id);
			} else {
				db.exec('DELETE FROM collection_card_tags');
			}

			db.exec('DROP TABLE tags');
			db.exec('ALTER TABLE tags_new RENAME TO tags');
		}
	},
	{
		id: '0008_price_history_day_dedup',
		run: (db) => {
			// Keep only the most recent row per (card_id, DATE(recorded_at)).
			db.exec(`
				DELETE FROM price_history
				WHERE id NOT IN (
					SELECT MAX(id) FROM price_history
					GROUP BY card_id, DATE(recorded_at)
				)
			`);
			// UNIQUE on an expression: allowed in SQLite since 3.9. Required for
			// the ON CONFLICT upsert in price-updater.ts.
			db.exec(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_card_day ON price_history(card_id, DATE(recorded_at))`
			);
		}
	},
	{
		id: '0009_api_usage_table',
		run: (db) => {
			db.exec(`
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
			db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_user_created ON api_usage(user_id, created_at DESC)');
			db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_service_created ON api_usage(service, created_at DESC)');
		}
	},
	{
		id: '0010_contact_messages_table',
		run: (db) => {
			db.exec(`
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
			db.exec('CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at ON contact_messages(created_at DESC)');
		}
	},
	{
		id: '0011_cards_released_at_index',
		run: (db) =>
			db.exec('CREATE INDEX IF NOT EXISTS idx_cards_released_at ON cards(released_at)')
	},
	{
		id: '0012_tags_user_id_index',
		run: (db) => db.exec('CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id)')
	},
	{
		id: '0013_wishlist_cards_user_id_index',
		run: (db) => {
			// Guard against very old DBs where user_id may not exist on wishlist_cards
			// yet — the original code never added it via ALTER. If it's missing,
			// add it first (matches the same scheme used for collection_cards).
			addColumnIfMissing(db, 'wishlist_cards', 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');
			db.exec('CREATE INDEX IF NOT EXISTS idx_wishlist_cards_user_id ON wishlist_cards(user_id)');
		}
	},
	{
		id: '0014_cards_cardmarket_id',
		run: (db) => {
			addColumnIfMissing(db, 'cards', 'cardmarket_id', 'INTEGER');
			db.exec('CREATE INDEX IF NOT EXISTS idx_cards_cardmarket_id ON cards(cardmarket_id)');
		}
	}
];

export function initDb() {
	// Base schema — idempotent CREATE IF NOT EXISTS statements. Fresh installs
	// come out of this with the current schema; existing installs pick up new
	// tables/indexes automatically, and the migration runner below patches
	// anything that predates this file.
	sqlite.exec(SCHEMA_SQL);

	// FTS5 sync triggers. For external-content FTS5, writes happen via rowid
	// and a special 'delete' directive that includes the old column values so
	// the FTS index can remove them precisely.
	sqlite.exec('DROP TRIGGER IF EXISTS cards_fts_insert');
	sqlite.exec('DROP TRIGGER IF EXISTS cards_fts_update');
	sqlite.exec('DROP TRIGGER IF EXISTS cards_fts_delete');
	sqlite.exec(`
		CREATE TRIGGER cards_fts_insert AFTER INSERT ON cards BEGIN
			INSERT INTO cards_fts(rowid, name, type_line, oracle_text)
			VALUES (NEW.rowid, NEW.name, COALESCE(NEW.type_line, ''), COALESCE(NEW.oracle_text, ''));
		END;
	`);
	sqlite.exec(`
		CREATE TRIGGER cards_fts_update AFTER UPDATE OF name, type_line, oracle_text ON cards BEGIN
			INSERT INTO cards_fts(cards_fts, rowid, name, type_line, oracle_text)
			VALUES ('delete', OLD.rowid, COALESCE(OLD.name, ''), COALESCE(OLD.type_line, ''), COALESCE(OLD.oracle_text, ''));
			INSERT INTO cards_fts(rowid, name, type_line, oracle_text)
			VALUES (NEW.rowid, NEW.name, COALESCE(NEW.type_line, ''), COALESCE(NEW.oracle_text, ''));
		END;
	`);
	sqlite.exec(`
		CREATE TRIGGER cards_fts_delete AFTER DELETE ON cards BEGIN
			INSERT INTO cards_fts(cards_fts, rowid, name, type_line, oracle_text)
			VALUES ('delete', OLD.rowid, COALESCE(OLD.name, ''), COALESCE(OLD.type_line, ''), COALESCE(OLD.oracle_text, ''));
		END;
	`);

	runMigrations(sqlite, MIGRATIONS);

	// Expired-session cleanup. Cheap, bounded by sessions count; runs once at
	// boot so admin-triggered cleanups aren't necessary for normal operation.
	try {
		sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
	} catch { /* ignore */ }

	// Refresh query planner stats so new indexes are used.
	try {
		sqlite.pragma('optimize');
	} catch { /* ignore */ }
}

export { sqlite };
