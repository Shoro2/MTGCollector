import type { Database } from 'better-sqlite3';

// Cover the date grouping and distinct printing count without sorting the
// entire history. LIMIT can stop after the latest ten date groups.
export const SNAPSHOT_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_price_history_snapshot_card ON price_history(snapshot_date DESC, card_id)';

export function recentSnapshots(db: Database) {
	return db.prepare(`SELECT snapshot_date, COUNT(DISTINCT card_id) AS cards_snapshotted
		FROM price_history WHERE snapshot_date IS NOT NULL
		GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 10`).all() as Array<{ snapshot_date: string; cards_snapshotted: number }>;
}

export function priceHistoryRange(db: Database) {
	// Separate scalar lookups use the ends of the recorded_at index. Combining
	// MIN and MAX in one aggregate caused a full scan of 7.85 million entries.
	return db.prepare(`SELECT (SELECT MIN(recorded_at) FROM price_history) AS earliest,
		(SELECT MAX(recorded_at) FROM price_history) AS latest`).get() as { earliest: string | null; latest: string | null };
}
