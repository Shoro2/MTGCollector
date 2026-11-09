import type Database from 'better-sqlite3';

// The /cards catalogue lists cards by default: one tile per card (oracle id), which opens
// the card page, the URL search engines index. `printings=1` lists every printing instead.
// Before 2026-11-09 the printings were the default, so the ~2,900 indexable catalogue pages
// linked ~115k printing URLs that all point their canonical to the ~37k card pages, and
// Google spent its crawl on them (Search Console 2026-11-09: 12,401 "discovered, currently
// not indexed"). A printing without an oracle id is a card of its own.
const CARD_KEY = 'COALESCE(cards.oracle_id, cards.id)';

// The printing a card's tile shows: the card page's representative printing
// (pickMainPrinting() in card-page.ts): with an image and a non-foil price, newest first,
// the id as tie-break.
const REPRESENTATIVE_ORDER = `(CASE WHEN cards.image_uri IS NOT NULL OR cards.local_image_path IS NOT NULL THEN 0 ELSE 2 END)
	+ (CASE WHEN cards.price_eur IS NOT NULL OR cards.price_usd IS NOT NULL THEN 0 ELSE 1 END),
	cards.released_at DESC, cards.id ASC`;

export const CATALOGUE_COLUMNS = ['id', 'oracle_id', 'layout', 'name', 'set_code', 'set_name', 'rarity', 'image_uri',
	'local_image_path', 'price_eur', 'price_usd', 'price_eur_foil', 'price_usd_foil', 'mana_cost', 'cmc', 'power',
	'toughness', 'released_at'] as const;
const COLUMNS = CATALOGUE_COLUMNS.map(c => `cards.${c}`).join(', ');

export type CatalogueQuery = {
	/** SQL conditions on the `cards` table, joined with AND. */
	conditions: string[];
	params: (string | number)[];
	/**
	 * Whether a condition depends on the printing (set, rarity). Then the tile is picked among
	 * the matching printings; otherwise every printing of a card matches alike (name, rules
	 * text, colours, type, mana value, legality) and the precomputed tile is used.
	 */
	printingConditions: boolean;
	/** Every printing instead of one per card. */
	printings: boolean;
	/** ORDER BY expressions on `cards.*` columns, from a whitelist. */
	orderBy: string;
	limit: number;
	offset: number;
};

// The tile of every card, kept in a temporary table of this connection (memory, never on
// disk, nothing to migrate or dump). Picking it per request ranked all ~115k printings and
// took ~0.4 s for every catalogue page (synthetic 115k-row database, 2026-11-09).
// Rebuilt when a card was added or after TILE_TTL_MS, because a price or image that appears
// can change a card's tile; invalidateCardTiles() rebuilds it after the price update.
const TILE_TTL_MS = 6 * 60 * 60 * 1000;
const tileState = new WeakMap<Database.Database, { maxRowid: number; builtAt: number }>();

export function invalidateCardTiles(db: Database.Database): void {
	tileState.delete(db);
}

function ensureCardTiles(db: Database.Database): void {
	const maxRowid = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM cards').get() as { n: number }).n;
	const state = tileState.get(db);
	if (state && state.maxRowid === maxRowid && Date.now() - state.builtAt < TILE_TTL_MS) return;
	db.transaction(() => {
		db.exec('CREATE TEMP TABLE IF NOT EXISTS card_tiles (card_id TEXT PRIMARY KEY) WITHOUT ROWID');
		db.exec('DELETE FROM temp.card_tiles');
		db.exec(`INSERT INTO temp.card_tiles (card_id) SELECT id FROM (SELECT cards.id,
			ROW_NUMBER() OVER (PARTITION BY ${CARD_KEY} ORDER BY ${REPRESENTATIVE_ORDER}) AS rn FROM cards) WHERE rn = 1`);
	})();
	tileState.set(db, { maxRowid, builtAt: Date.now() });
}

export function catalogueSql(conditions: string[], mode: 'printings' | 'tiles' | 'ranked', orderBy: string) {
	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
	if (mode === 'printings') {
		return {
			countSql: `SELECT COUNT(*) AS count FROM cards ${where}`,
			resultSql: `SELECT ${COLUMNS} FROM cards ${where} ORDER BY ${orderBy}, cards.id ASC LIMIT ? OFFSET ?`
		};
	}
	if (mode === 'tiles') {
		const from = 'cards JOIN temp.card_tiles tile ON tile.card_id = cards.id';
		return {
			countSql: `SELECT COUNT(*) AS count FROM ${from} ${where}`,
			resultSql: `SELECT ${COLUMNS} FROM ${from} ${where} ORDER BY ${orderBy}, cards.id ASC LIMIT ? OFFSET ?`
		};
	}
	// The outer query names the kept rows `cards` again, so the whitelisted ORDER BY expressions apply unchanged.
	return {
		countSql: `SELECT COUNT(DISTINCT ${CARD_KEY}) AS count FROM cards ${where}`,
		resultSql: `WITH ranked AS (SELECT ${COLUMNS}, ROW_NUMBER() OVER (PARTITION BY ${CARD_KEY} ORDER BY ${REPRESENTATIVE_ORDER}) AS rn
			FROM cards ${where})
			SELECT ${COLUMNS} FROM (SELECT * FROM ranked WHERE rn = 1) AS cards ORDER BY ${orderBy}, cards.id ASC LIMIT ? OFFSET ?`
	};
}

export function queryCatalogue(db: Database.Database, q: CatalogueQuery) {
	const mode = q.printings ? 'printings' : q.printingConditions ? 'ranked' : 'tiles';
	if (mode === 'tiles') ensureCardTiles(db);
	const { countSql, resultSql } = catalogueSql(q.conditions, mode, q.orderBy);
	const total = (db.prepare(countSql).get(...q.params) as { count: number }).count;
	const rows = db.prepare(resultSql).all(...q.params, q.limit, q.offset) as Array<Record<string, unknown>>;
	return { total, rows };
}

/**
 * Which tiles of a page the user owns or wants. A card tile counts every printing of the
 * card; a printing tile only its own printing (as before).
 */
export function userMarks(db: Database.Database, userId: string, rows: Array<Record<string, unknown>>, printings: boolean) {
	if (!rows.length) return { collected: new Set<string>(), wishlist: new Set<string>() };
	const ids = rows.map(r => r.id as string);
	const placeholders = ids.map(() => '?').join(',');
	const mark = (table: 'collection_cards' | 'wishlist_cards') => {
		if (printings) {
			const found = db.prepare(`SELECT DISTINCT card_id AS id FROM ${table} WHERE user_id = ? AND card_id IN (${placeholders})`)
				.all(userId, ...ids) as Array<{ id: string }>;
			return new Set(found.map(r => r.id));
		}
		// The tile's printing stands for its card: any entry of any printing of the card counts.
		const found = db.prepare(`SELECT DISTINCT COALESCE(c.oracle_id, c.id) AS id FROM ${table} t
			JOIN cards c ON c.id = t.card_id WHERE t.user_id = ?`).all(userId) as Array<{ id: string }>;
		const keys = new Set(found.map(r => r.id));
		return new Set(rows.filter(r => keys.has((r.oracle_id ?? r.id) as string)).map(r => r.id as string));
	};
	return { collected: mark('collection_cards'), wishlist: mark('wishlist_cards') };
}
