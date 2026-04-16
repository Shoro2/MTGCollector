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

function tableColumnNames(table: string): Set<string> {
	const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return new Set(rows.map((r) => r.name));
}

function addColumnIfMissing(table: string, column: string, definition: string) {
	if (tableColumnNames(table).has(column)) return;
	sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateFtsToExternalContent() {
	// Old FTS5 schema exposed a `card_id` column and stored its own copy of
	// name/type_line/oracle_text. Detect and replace with an external-content
	// FTS that reads directly from cards via rowid.
	let needsRebuild = false;
	try {
		const cols = tableColumnNames('cards_fts');
		if (cols.has('card_id')) needsRebuild = true;
	} catch {
		// Virtual tables sometimes don't answer PRAGMA; fall back to probing.
		needsRebuild = true;
	}

	if (!needsRebuild) return;

	sqlite.exec('DROP TABLE IF EXISTS cards_fts');
	sqlite.exec(`
		CREATE VIRTUAL TABLE cards_fts USING fts5(
			name, type_line, oracle_text,
			content='cards',
			content_rowid='rowid'
		)
	`);
	sqlite.exec(`INSERT INTO cards_fts(cards_fts) VALUES('rebuild')`);
}

function dedupePriceHistoryPerDay() {
	// Keep only the most recent row per (card_id, DATE(recorded_at)). Safe to
	// re-run on each boot; it's a no-op once the UNIQUE index is in place.
	sqlite.exec(`
		DELETE FROM price_history
		WHERE id NOT IN (
			SELECT MAX(id) FROM price_history
			GROUP BY card_id, DATE(recorded_at)
		)
	`);
}

function ensurePriceHistoryDailyUnique() {
	// UNIQUE on an expression: allowed in SQLite since 3.9. Required for the
	// ON CONFLICT upsert in price-updater.ts.
	sqlite.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_card_day ON price_history(card_id, DATE(recorded_at))`
	);
}

function migrateTagsToPerUser() {
	// Old schema had `name TEXT NOT NULL UNIQUE` (column-level, auto-indexed and
	// undroppable), so the only way to get (user_id, name) composite uniqueness
	// is to recreate the table. Idempotent: skipped once user_id exists.
	const cols = tableColumnNames('tags');
	if (cols.has('user_id')) return;

	// Pick a default owner for existing (formerly global) tags: prefer the
	// ADMIN_EMAIL user, fall back to the oldest account. If there are no
	// users at all (dev scaffold), wipe the orphan tags and their join rows —
	// they're already unreachable through the user-scoped UI.
	const adminEmail = (process.env.ADMIN_EMAIL ?? '').toLowerCase();
	const defaultOwner = sqlite.prepare(
		`SELECT id FROM users
		 ORDER BY CASE WHEN LOWER(email) = ? THEN 0 ELSE 1 END, created_at ASC
		 LIMIT 1`
	).get(adminEmail) as { id: string } | undefined;

	sqlite.transaction(() => {
		sqlite.exec(`
			CREATE TABLE tags_new (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
				name TEXT NOT NULL,
				color TEXT DEFAULT '#3b82f6',
				UNIQUE(user_id, name)
			)
		`);

		if (defaultOwner) {
			sqlite.prepare(
				`INSERT INTO tags_new (id, user_id, name, color)
				 SELECT id, ?, name, color FROM tags`
			).run(defaultOwner.id);
		} else {
			sqlite.exec('DELETE FROM collection_card_tags');
		}

		sqlite.exec('DROP TABLE tags');
		sqlite.exec('ALTER TABLE tags_new RENAME TO tags');
	})();
}

export function initDb() {
	sqlite.exec(SCHEMA_SQL);

	// FTS5 sync triggers. For external-content FTS5, writes happen via rowid
	// and a special 'delete' directive that includes the old column values
	// so the FTS index can remove them precisely.
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

	// Migrations for existing databases.
	addColumnIfMissing('collection_cards', 'purchase_price', 'REAL');
	addColumnIfMissing('collection_cards', 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');
	addColumnIfMissing('cards', 'price_usd', 'REAL');
	addColumnIfMissing('cards', 'price_usd_foil', 'REAL');
	addColumnIfMissing('price_history', 'price_usd', 'REAL');
	addColumnIfMissing('price_history', 'price_usd_foil', 'REAL');
	addColumnIfMissing('users', 'google_vision_api_key', 'TEXT');

	migrateFtsToExternalContent();
	migrateTagsToPerUser();
	dedupePriceHistoryPerDay();
	ensurePriceHistoryDailyUnique();

	// Indexes that may not be present on pre-existing databases. The schema-sql
	// CREATE INDEX IF NOT EXISTS statements run inside SCHEMA_SQL above, so
	// these are for belt-and-suspenders in case that block gets re-ordered.
	sqlite.exec('CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id)');
	sqlite.exec('CREATE INDEX IF NOT EXISTS idx_cards_released_at ON cards(released_at)');

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
	sqlite.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_user_created ON api_usage(user_id, created_at DESC)');
	sqlite.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_service_created ON api_usage(service, created_at DESC)');

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
