/**
 * Minimal versioned migration runner. Tracks applied migrations by id in
 * `_schema_migrations` so each step runs at most once per database, even
 * across restarts. Keeps the surface area small — this is a single-file
 * SQLite app, not a sharded distributed system.
 *
 * Each migration's `run` function must be idempotent as a belt-and-
 * suspenders guarantee: if someone manually resets the migrations table,
 * re-running should still converge on the target schema.
 */

import type { Database } from 'better-sqlite3';

export interface Migration {
	/** Stable identifier. Do NOT change once released. */
	id: string;
	/** Apply the migration. Wrapped in a transaction by the runner. */
	run: (db: Database) => void;
}

export function runMigrations(db: Database, migrations: Migration[]): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS _schema_migrations (
			id TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	const appliedRows = db
		.prepare('SELECT id FROM _schema_migrations')
		.all() as Array<{ id: string }>;
	const applied = new Set(appliedRows.map((r) => r.id));

	const record = db.prepare('INSERT INTO _schema_migrations (id) VALUES (?)');

	for (const migration of migrations) {
		if (applied.has(migration.id)) continue;
		try {
			db.transaction(() => {
				migration.run(db);
				record.run(migration.id);
			})();
			console.log(`[db] Applied migration: ${migration.id}`);
		} catch (err) {
			console.error(`[db] Migration "${migration.id}" failed:`, err);
			throw err;
		}
	}
}
