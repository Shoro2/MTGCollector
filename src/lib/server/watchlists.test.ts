import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema-sql';
import {
	WATCHLISTS_SQL, WatchlistError, addWatchEntry, createWatchlist, defaultWatchlist, deleteWatchlist, latestPriceRefs, printingWatches,
	removeWatchEntry, renameWatchlist, updateWatchEntry, userWatchlists, watchEntryCount, watchlistView
} from './watchlists';
import { MAX_LISTS } from '../watchlist';

function fixture() {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	db.exec(SCHEMA_SQL);
	db.exec(WATCHLISTS_SQL);
	db.exec(`INSERT INTO users (id, google_id, email, name) VALUES ('a', 'a', 'a@example.invalid', 'A'), ('b', 'b', 'b@example.invalid', 'B');
		INSERT INTO cards (id, name, set_code, set_name, collector_number, price_eur, price_eur_foil, price_usd, price_usd_foil) VALUES
			('bolt', 'Lightning Bolt', 'clu', 'Clue', '141', 2, 5, 2.5, NULL),
			('ring', 'Sol Ring', 'c21', 'Commander 2021', '263', 1, NULL, 1.2, NULL);
		INSERT INTO price_history (card_id, price_eur, price_eur_foil, price_usd, price_usd_foil, recorded_at, snapshot_date, language) VALUES
			('bolt', 1.5, 4, 2, NULL, '2026-10-30T18:05:00Z', '2026-10-30', 'en'),
			('bolt', 2, 5, 2.5, NULL, '2026-11-01T18:05:00Z', '2026-11-01', 'en'),
			('bolt', 9, 9, 9, NULL, '2026-11-01T18:05:00Z', '2026-11-01', 'de'),
			('ring', 1, NULL, 1.2, NULL, '2026-11-01T18:05:00Z', '2026-11-01', 'en');`);
	return db;
}

const error = (run: () => unknown) => {
	try {
		run();
	} catch (err) {
		if (err instanceof WatchlistError) return [err.status, err.message];
		throw err;
	}
	return null;
};

describe('lists', () => {
	it('creates, renames and deletes lists of one user only', () => {
		const db = fixture();
		const id = createWatchlist(db, 'a', ' Buy later ', '2026-11-01T10:00:00Z');
		expect(userWatchlists(db, 'a')).toEqual([{ id, name: 'Buy later', entries: 0, created_at: '2026-11-01T10:00:00Z' }]);
		expect(error(() => createWatchlist(db, 'a', 'buy LATER'))?.[0]).toBe(409);
		expect(error(() => createWatchlist(db, 'a', '   '))?.[0]).toBe(400);
		expect(error(() => renameWatchlist(db, 'b', id, 'Mine now'))?.[0]).toBe(404);
		renameWatchlist(db, 'a', id, 'Sell');
		expect(userWatchlists(db, 'a')[0].name).toBe('Sell');
		expect(error(() => deleteWatchlist(db, 'b', id))?.[0]).toBe(404);
		addWatchEntry(db, 'a', { cardId: 'bolt', listId: id }, 'EUR');
		deleteWatchlist(db, 'a', id);
		expect(userWatchlists(db, 'a')).toEqual([]);
		expect(db.prepare('SELECT COUNT(*) AS n FROM watchlist_cards').get()).toEqual({ n: 0 });
	});

	it('caps the number of lists', () => {
		const db = fixture();
		for (let i = 0; i < MAX_LISTS; i++) createWatchlist(db, 'a', `List ${i}`);
		expect(error(() => createWatchlist(db, 'a', 'One more'))?.[0]).toBe(400);
		expect(createWatchlist(db, 'b', 'List 0')).toBeGreaterThan(0);
	});

	it('creates the default list on the first add without a list', () => {
		const db = fixture();
		const { listId } = addWatchEntry(db, 'a', { cardId: 'bolt' }, 'USD');
		expect(userWatchlists(db, 'a').map((l) => [l.id, l.name, l.entries])).toEqual([[listId, 'Watchlist', 1]]);
		expect(defaultWatchlist(db, 'a')).toBe(listId);
	});
});

describe('entries', () => {
	it('adds a printing once per finish and list, and only to own lists', () => {
		const db = fixture();
		const mine = createWatchlist(db, 'a', 'Mine');
		const theirs = createWatchlist(db, 'b', 'Theirs');
		addWatchEntry(db, 'a', { cardId: 'bolt', listId: mine }, 'EUR');
		expect(error(() => addWatchEntry(db, 'a', { cardId: 'bolt', listId: mine }, 'EUR'))?.[0]).toBe(409);
		addWatchEntry(db, 'a', { cardId: 'bolt', listId: mine, foil: true }, 'EUR');
		expect(error(() => addWatchEntry(db, 'a', { cardId: 'bolt', listId: theirs }, 'EUR'))?.[0]).toBe(404);
		expect(error(() => addWatchEntry(db, 'a', { cardId: 'nope', listId: mine }, 'EUR'))?.[0]).toBe(404);
		expect(error(() => addWatchEntry(db, 'a', { cardId: 'ring', listId: mine, targetPrice: -1 }, 'EUR'))?.[0]).toBe(400);
		expect(error(() => addWatchEntry(db, 'a', { cardId: 'ring', listId: mine, notes: 'x'.repeat(501) }, 'EUR'))?.[0]).toBe(400);
		expect(printingWatches(db, 'a', 'bolt').map((w) => [w.listName, w.foil])).toEqual([['Mine', 0], ['Mine', 1]]);
		expect(printingWatches(db, 'b', 'bolt')).toEqual([]);
		expect(watchEntryCount(db, 'a')).toBe(2);
	});

	it('stores a target in the display currency and edits, moves and removes entries', () => {
		const db = fixture();
		const first = createWatchlist(db, 'a', 'First');
		const second = createWatchlist(db, 'a', 'Second');
		const { id } = addWatchEntry(db, 'a', { cardId: 'bolt', listId: first, targetPrice: '1,5', notes: ' cheap ' }, 'USD');
		expect(db.prepare('SELECT target_price, target_currency, target_direction, notes FROM watchlist_cards WHERE id = ?').get(id))
			.toEqual({ target_price: 1.5, target_currency: 'USD', target_direction: 'below', notes: 'cheap' });

		updateWatchEntry(db, 'a', { rowId: id, targetDirection: 'above', notes: '' });
		expect(db.prepare('SELECT target_price, target_currency, target_direction, notes FROM watchlist_cards WHERE id = ?').get(id))
			.toEqual({ target_price: 1.5, target_currency: 'USD', target_direction: 'above', notes: '' });
		updateWatchEntry(db, 'a', { rowId: id, targetPrice: null });
		expect((db.prepare('SELECT target_price FROM watchlist_cards WHERE id = ?').get(id) as { target_price: number | null }).target_price).toBeNull();

		addWatchEntry(db, 'a', { cardId: 'bolt', listId: second }, 'EUR');
		expect(error(() => updateWatchEntry(db, 'a', { rowId: id, listId: second }))?.[0]).toBe(409);
		updateWatchEntry(db, 'a', { rowId: id, listId: second, foil: true });
		expect(userWatchlists(db, 'a').map((l) => l.entries)).toEqual([0, 2]);

		expect(error(() => updateWatchEntry(db, 'b', { rowId: id, notes: 'hijack' }))?.[0]).toBe(404);
		expect(error(() => removeWatchEntry(db, 'b', id))?.[0]).toBe(404);
		removeWatchEntry(db, 'a', id);
		expect(watchEntryCount(db, 'a')).toBe(1);
	});

	it('goes with the account', () => {
		const db = fixture();
		addWatchEntry(db, 'a', { cardId: 'bolt' }, 'EUR');
		db.prepare('DELETE FROM users WHERE id = ?').run('a');
		expect(db.prepare('SELECT (SELECT COUNT(*) FROM watchlists) + (SELECT COUNT(*) FROM watchlist_cards) AS n').get()).toEqual({ n: 0 });
	});
});

describe('the priced view', () => {
	it('reads English history only and measures against the update before', () => {
		const db = fixture();
		expect(latestPriceRefs(db)).toMatchObject({ latest: '2026-11-01', previous: '2026-10-30' });
		const list = createWatchlist(db, 'a', 'Mine');
		addWatchEntry(db, 'a', { cardId: 'bolt', listId: list }, 'EUR', '2026-10-31T09:00:00Z');
		addWatchEntry(db, 'a', { cardId: 'ring', listId: list }, 'EUR', '2026-11-01T20:00:00Z');
		const view = watchlistView(db, 'a', list, 'EUR');
		const bolt = view.rows.find((r) => r.cardId === 'bolt')!;
		expect(bolt.price).toBe(2);
		expect(bolt.day).toEqual({ amount: 0.5, percent: (0.5 / 1.5) * 100 });
		expect(bolt.addedPrice).toBe(1.5);
		const ring = view.rows.find((r) => r.cardId === 'ring')!;
		expect(ring.day).toBeNull();
		expect(ring.sinceAdded).toEqual({ amount: 0, percent: 0 });
		expect(error(() => watchlistView(db, 'b', list, 'EUR'))?.[0]).toBe(404);
	});
});
