import type { Database } from 'better-sqlite3';
import type { MoverRow } from '../home';

// Homepage reads. The connection is injected: tests use an in-memory database, never db.ts.

/**
 * Every English price snapshot of the latest snapshot day (from €`minPrice`) with
 * the printing's snapshot before it. Snapshots are written only when a price
 * changes, so the previous row is the price the printing had until that day,
 * provided the updater ran on the days between.
 */
export function priceMoverRows(db: Database, minPrice = 2): { date: string | null; previousDate: string | null; rows: MoverRow[] } {
	const latest = db.prepare("SELECT MAX(snapshot_date) AS d FROM price_history WHERE language = 'en' AND snapshot_date < ?");
	const date = (latest.get('9999') as { d: string | null }).d;
	if (!date) return { date: null, previousDate: null, rows: [] };
	// The update before: a gap (server down, a stale copy) makes every move span it.
	const previousDate = (latest.get(date) as { d: string | null }).d;
	const rows = db.prepare(`SELECT c.oracle_id, c.name, c.set_code, t.price_eur AS now, t.price_usd AS usd,
			p.price_eur AS prev, p.price_usd AS prevUsd
		FROM price_history t JOIN cards c ON c.id = t.card_id
		LEFT JOIN price_history p ON p.rowid = (SELECT q.rowid FROM price_history q
			WHERE q.card_id = t.card_id AND q.language = 'en' AND q.snapshot_date < t.snapshot_date
			ORDER BY q.snapshot_date DESC LIMIT 1)
		WHERE t.snapshot_date = ? AND t.language = 'en' AND t.price_eur >= ? AND c.oracle_id IS NOT NULL
		ORDER BY c.oracle_id, c.id`).all(date, minPrice) as MoverRow[];
	return { date, previousDate, rows };
}

export type RecentEntry = {
	id: number;
	card_id: string;
	name: string;
	set_code: string;
	quantity: number;
	location: string;
	proxy: number;
	foil: number;
	language: string;
	price: number | null;
	price_usd: number | null;
};

/** The user's newest collection entries, priced like getPriceData(): own language first, English as fallback. */
export function recentlyAdded(db: Database, userId: string, limit = 5): RecentEntry[] {
	return db.prepare(`SELECT cc.id, cc.card_id, c.name, c.set_code, cc.quantity, cc.location, cc.proxy, cc.foil,
			COALESCE(cc.language, 'en') AS language,
			CASE WHEN cc.foil = 1 THEN COALESCE(cpl.price_eur_foil, c.price_eur_foil) ELSE COALESCE(cpl.price_eur, c.price_eur) END AS price,
			CASE WHEN cc.foil = 1 THEN COALESCE(cpl.price_usd_foil, c.price_usd_foil) ELSE COALESCE(cpl.price_usd, c.price_usd) END AS price_usd
		FROM collection_cards cc JOIN cards c ON c.id = cc.card_id
		LEFT JOIN card_prices_lang cpl ON cpl.card_id = cc.card_id AND cpl.language = COALESCE(cc.language, 'en')
		WHERE cc.user_id = ? ORDER BY cc.added_at DESC, cc.id DESC LIMIT ?`).all(userId, limit) as RecentEntry[];
}

export function wishlistCount(db: Database, userId: string): number {
	return (db.prepare('SELECT COUNT(*) AS n FROM wishlist_cards WHERE user_id = ?').get(userId) as { n: number }).n;
}

/** The cheapest, a middle and the most expensive paper printing of a card, for the visitor homepage. */
export function printingPriceSample(db: Database, name: string): Array<{ set_name: string; price: number }> {
	const all = db.prepare(`SELECT set_name, price_eur AS price FROM cards
		WHERE name = ? AND price_eur IS NOT NULL AND COALESCE(is_paper, 1) = 1
		ORDER BY price_eur, id`).all(name) as Array<{ set_name: string; price: number }>;
	if (!all.length) return [];
	return [...new Set([0, Math.floor((all.length - 1) / 2), all.length - 1])].map(i => all[i]);
}

/** Set codes of a few printings (getPriceData() rows carry the set name only). */
export function setCodes(db: Database, ids: string[]): Map<string, string> {
	if (!ids.length) return new Map();
	const rows = db.prepare(`SELECT id, set_code FROM cards WHERE id IN (${ids.map(() => '?').join(',')})`)
		.all(...ids) as Array<{ id: string; set_code: string }>;
	return new Map(rows.map(r => [r.id, r.set_code]));
}
