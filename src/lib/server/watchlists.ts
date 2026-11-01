import type { Database } from 'better-sqlite3';
import { parseCurrency, type Currency } from '../currency.js';
import {
	DEFAULT_LIST_NAME, MAX_ENTRIES, MAX_LISTS, MAX_NOTES, cleanListName, parseTargetDirection, priceRefs, watchRow,
	type PriceRefs, type PriceRow, type WatchEntry, type WatchRow
} from '../watchlist.js';

// Price watchlists (/watchlist, migration 0034_watchlists): a user's named lists of
// printings with a finish, an optional target price and a note. The database is
// injected so the unit tests never open the application database (CLAUDE.md §8.1).
// User data: the nightly user-data dump must list both tables.

export const WATCHLISTS_SQL = `
CREATE TABLE IF NOT EXISTS watchlists (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS watchlist_cards (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
	card_id TEXT NOT NULL REFERENCES cards(id),
	foil INTEGER NOT NULL DEFAULT 0 CHECK (foil IN (0, 1)),
	target_price REAL CHECK (target_price IS NULL OR target_price >= 0),
	target_currency TEXT NOT NULL DEFAULT 'EUR' CHECK (target_currency IN ('EUR', 'USD')),
	target_direction TEXT NOT NULL DEFAULT 'below' CHECK (target_direction IN ('below', 'above')),
	notes TEXT NOT NULL DEFAULT '',
	added_at TEXT NOT NULL,
	UNIQUE (watchlist_id, card_id, foil)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_cards_card ON watchlist_cards(card_id);
`;

export class WatchlistError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

const listNotFound = () => new WatchlistError('List not found.', 404);
const entryNotFound = () => new WatchlistError('Entry not found.', 404);

export type WatchlistSummary = { id: number; name: string; entries: number; created_at: string };

/** The user's lists, oldest first, with their entry counts. */
export function userWatchlists(db: Database, userId: string): WatchlistSummary[] {
	return db.prepare(`SELECT w.id, w.name, w.created_at, COUNT(wc.id) AS entries
		FROM watchlists w LEFT JOIN watchlist_cards wc ON wc.watchlist_id = w.id
		WHERE w.user_id = ? GROUP BY w.id ORDER BY w.created_at, w.id`).all(userId) as WatchlistSummary[];
}

function ownList(db: Database, userId: string, listId: unknown): { id: number; name: string } {
	const id = Number(listId);
	if (!Number.isInteger(id) || id <= 0) throw listNotFound();
	const list = db.prepare('SELECT id, name FROM watchlists WHERE id = ? AND user_id = ?').get(id, userId) as { id: number; name: string } | undefined;
	if (!list) throw listNotFound();
	return list;
}

function nameTaken(db: Database, userId: string, name: string, exceptId = 0): boolean {
	return !!db.prepare('SELECT 1 FROM watchlists WHERE user_id = ? AND lower(name) = lower(?) AND id != ?').get(userId, name, exceptId);
}

function requireName(value: unknown): string {
	const name = cleanListName(value);
	if (!name) throw new WatchlistError('Give the list a name of 1 to 60 characters.');
	return name;
}

/** Creates a list and returns its id. */
export function createWatchlist(db: Database, userId: string, rawName: unknown, now = new Date().toISOString()): number {
	const name = requireName(rawName);
	return db.transaction(() => {
		const { count } = db.prepare('SELECT COUNT(*) AS count FROM watchlists WHERE user_id = ?').get(userId) as { count: number };
		if (count >= MAX_LISTS) throw new WatchlistError(`You can keep at most ${MAX_LISTS} watchlists.`);
		if (nameTaken(db, userId, name)) throw new WatchlistError(`You already have a list called "${name}".`, 409);
		return Number(db.prepare('INSERT INTO watchlists (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(userId, name, now, now).lastInsertRowid);
	})();
}

export function renameWatchlist(db: Database, userId: string, listId: unknown, rawName: unknown, now = new Date().toISOString()) {
	const list = ownList(db, userId, listId);
	const name = requireName(rawName);
	if (nameTaken(db, userId, name, list.id)) throw new WatchlistError(`You already have a list called "${name}".`, 409);
	db.prepare('UPDATE watchlists SET name = ?, updated_at = ? WHERE id = ?').run(name, now, list.id);
}

/** Deletes a list with its entries (cascade). */
export function deleteWatchlist(db: Database, userId: string, listId: unknown) {
	const list = ownList(db, userId, listId);
	db.prepare('DELETE FROM watchlists WHERE id = ?').run(list.id);
}

/** The user's first list, created as "Watchlist" when there is none. */
export function defaultWatchlist(db: Database, userId: string, now = new Date().toISOString()): number {
	const first = db.prepare('SELECT id FROM watchlists WHERE user_id = ? ORDER BY created_at, id LIMIT 1').get(userId) as { id: number } | undefined;
	return first ? first.id : createWatchlist(db, userId, DEFAULT_LIST_NAME, now);
}

function parseFoil(value: unknown): 0 | 1 {
	return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

type TargetFields = { target_price: number | null; target_currency: Currency; target_direction: string };

/** Target fields from a request; `undefined` keys keep the stored values (PATCH). */
function parseTarget(body: Record<string, unknown>, fallbackCurrency: Currency): Partial<TargetFields> {
	const out: Partial<TargetFields> = {};
	if ('targetPrice' in body) {
		const raw = body.targetPrice;
		if (raw === null || raw === '' || raw === undefined) out.target_price = null;
		else {
			const value = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
			if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new WatchlistError('Enter a target price between 0 and 1,000,000, or leave it empty.');
			out.target_price = Math.round(value * 100) / 100;
		}
		out.target_currency = 'targetCurrency' in body ? parseCurrency(body.targetCurrency) : fallbackCurrency;
	} else if ('targetCurrency' in body) {
		out.target_currency = parseCurrency(body.targetCurrency);
	}
	if ('targetDirection' in body) out.target_direction = parseTargetDirection(body.targetDirection);
	return out;
}

function parseNotes(value: unknown): string {
	if (value == null) return '';
	if (typeof value !== 'string') throw new WatchlistError('Notes must be text.');
	const notes = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
	if (notes.length > MAX_NOTES) throw new WatchlistError(`Keep the note under ${MAX_NOTES} characters.`);
	return notes;
}

function cardExists(db: Database, cardId: unknown): cardId is string {
	return typeof cardId === 'string' && cardId.length <= 64 && !!db.prepare('SELECT 1 FROM cards WHERE id = ?').get(cardId);
}

function assertRoom(db: Database, listId: number) {
	const { count } = db.prepare('SELECT COUNT(*) AS count FROM watchlist_cards WHERE watchlist_id = ?').get(listId) as { count: number };
	if (count >= MAX_ENTRIES) throw new WatchlistError(`A list holds at most ${MAX_ENTRIES} cards. Start another list.`);
}

/**
 * Adds a printing: `{ cardId, foil?, listId?, targetPrice?, targetCurrency?, targetDirection?, notes? }`.
 * Without `listId` the user's first list (created when there is none). The same printing
 * and finish once per list (409). Returns the entry and list ids.
 */
export function addWatchEntry(db: Database, userId: string, body: Record<string, unknown>, currency: Currency, now = new Date().toISOString()) {
	if (!cardExists(db, body.cardId)) throw new WatchlistError('Card not found.', 404);
	const cardId = body.cardId;
	const foil = parseFoil(body.foil);
	const target = parseTarget(body, currency);
	const notes = parseNotes(body.notes);
	return db.transaction(() => {
		const listId = body.listId == null || body.listId === '' ? defaultWatchlist(db, userId, now) : ownList(db, userId, body.listId).id;
		if (db.prepare('SELECT 1 FROM watchlist_cards WHERE watchlist_id = ? AND card_id = ? AND foil = ?').get(listId, cardId, foil)) {
			throw new WatchlistError(`This printing${foil ? ' in foil' : ''} is already on the list.`, 409);
		}
		assertRoom(db, listId);
		const id = Number(db.prepare(`INSERT INTO watchlist_cards (watchlist_id, card_id, foil, target_price, target_currency, target_direction, notes, added_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(listId, cardId, foil, target.target_price ?? null, target.target_currency ?? currency,
			target.target_direction ?? 'below', notes, now).lastInsertRowid);
		db.prepare('UPDATE watchlists SET updated_at = ? WHERE id = ?').run(now, listId);
		return { id, listId };
	})();
}

function ownEntry(db: Database, userId: string, rowId: unknown) {
	const id = Number(rowId);
	if (!Number.isInteger(id) || id <= 0) throw entryNotFound();
	const entry = db.prepare(`SELECT wc.id, wc.watchlist_id, wc.card_id, wc.foil, wc.target_price, wc.target_currency, wc.target_direction, wc.notes
		FROM watchlist_cards wc JOIN watchlists w ON w.id = wc.watchlist_id WHERE wc.id = ? AND w.user_id = ?`).get(id, userId) as
		{ id: number; watchlist_id: number; card_id: string; foil: number; target_price: number | null; target_currency: string; target_direction: string; notes: string } | undefined;
	if (!entry) throw entryNotFound();
	return entry;
}

/**
 * Changes one entry: `{ rowId, foil?, targetPrice?, targetCurrency?, targetDirection?, notes?, listId? }`.
 * `listId` moves it to another of the user's lists. A finish or list that already holds
 * the same printing is refused (409).
 */
export function updateWatchEntry(db: Database, userId: string, body: Record<string, unknown>, now = new Date().toISOString()) {
	const entry = ownEntry(db, userId, body.rowId);
	const target = parseTarget(body, parseCurrency(entry.target_currency));
	const foil = 'foil' in body ? parseFoil(body.foil) : entry.foil;
	const notes = 'notes' in body ? parseNotes(body.notes) : entry.notes;
	db.transaction(() => {
		const listId = 'listId' in body && body.listId != null && body.listId !== '' ? ownList(db, userId, body.listId).id : entry.watchlist_id;
		if (db.prepare('SELECT 1 FROM watchlist_cards WHERE watchlist_id = ? AND card_id = ? AND foil = ? AND id != ?').get(listId, entry.card_id, foil, entry.id)) {
			throw new WatchlistError(`That list already watches this printing${foil ? ' in foil' : ''}.`, 409);
		}
		if (listId !== entry.watchlist_id) assertRoom(db, listId);
		db.prepare(`UPDATE watchlist_cards SET watchlist_id = ?, foil = ?, target_price = ?, target_currency = ?, target_direction = ?, notes = ? WHERE id = ?`)
			.run(listId, foil, target.target_price !== undefined ? target.target_price : entry.target_price,
				target.target_currency ?? entry.target_currency, target.target_direction ?? entry.target_direction, notes, entry.id);
		db.prepare('UPDATE watchlists SET updated_at = ? WHERE id IN (?, ?)').run(now, listId, entry.watchlist_id);
	})();
}

export function removeWatchEntry(db: Database, userId: string, rowId: unknown) {
	const entry = ownEntry(db, userId, rowId);
	db.prepare('DELETE FROM watchlist_cards WHERE id = ?').run(entry.id);
}

/** Where a printing is watched, for its page: one item per entry. */
export function printingWatches(db: Database, userId: string, cardId: string) {
	return db.prepare(`SELECT wc.id, wc.watchlist_id AS listId, w.name AS listName, wc.foil
		FROM watchlist_cards wc JOIN watchlists w ON w.id = wc.watchlist_id
		WHERE w.user_id = ? AND wc.card_id = ? ORDER BY w.created_at, w.id, wc.foil`).all(userId, cardId) as
		Array<{ id: number; listId: number; listName: string; foil: number }>;
}

/** The newest price update and the one before it (served by the 0023 snapshot index on the host). */
export function latestPriceRefs(db: Database): PriceRefs {
	const latest = (db.prepare('SELECT MAX(snapshot_date) AS d FROM price_history').get() as { d: string | null }).d;
	const previous = latest
		? (db.prepare('SELECT MAX(snapshot_date) AS d FROM price_history WHERE snapshot_date < ?').get(latest) as { d: string | null }).d
		: null;
	return priceRefs(latest, previous);
}

/** English price history of the given printings, oldest first per printing. */
export function priceRowsFor(db: Database, cardIds: string[]): Map<string, PriceRow[]> {
	const out = new Map<string, PriceRow[]>();
	const unique = [...new Set(cardIds)];
	for (let i = 0; i < unique.length; i += 400) {
		const chunk = unique.slice(i, i + 400);
		const rows = db.prepare(`SELECT card_id, snapshot_date, recorded_at, price_eur, price_eur_foil, price_usd, price_usd_foil
			FROM price_history WHERE language = 'en' AND card_id IN (${chunk.map(() => '?').join(',')})
			ORDER BY card_id, snapshot_date, recorded_at`).all(...chunk) as Array<PriceRow & { card_id: string }>;
		for (const row of rows) {
			const list = out.get(row.card_id) ?? [];
			list.push(row);
			out.set(row.card_id, list);
		}
	}
	return out;
}

/** One list with its rows priced in `currency`; 404 for a list that is not the user's. */
export function watchlistView(db: Database, userId: string, listId: unknown, currency: Currency): { list: { id: number; name: string }; rows: WatchRow[]; refs: PriceRefs } {
	const list = ownList(db, userId, listId);
	const entries = db.prepare(`SELECT wc.id, wc.watchlist_id AS list_id, wc.card_id, wc.foil, wc.target_price, wc.target_currency, wc.target_direction,
			wc.notes, wc.added_at, c.name, c.set_code, c.set_name, c.collector_number, c.rarity, c.image_uri, c.local_image_path, c.mana_cost,
			c.price_eur, c.price_eur_foil, c.price_usd, c.price_usd_foil
		FROM watchlist_cards wc JOIN cards c ON c.id = wc.card_id
		WHERE wc.watchlist_id = ? ORDER BY wc.added_at DESC, wc.id DESC`).all(list.id) as WatchEntry[];
	const refs = latestPriceRefs(db);
	const history = priceRowsFor(db, entries.map((e) => e.card_id));
	return { list, refs, rows: entries.map((entry) => watchRow(entry, history.get(entry.card_id) ?? [], refs, currency)) };
}

/** Number of watched printings over all lists, for /settings. */
export function watchEntryCount(db: Database, userId: string): number {
	return (db.prepare('SELECT COUNT(*) AS count FROM watchlist_cards wc JOIN watchlists w ON w.id = wc.watchlist_id WHERE w.user_id = ?').get(userId) as { count: number }).count;
}
