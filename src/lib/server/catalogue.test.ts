import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from './schema-sql';
import { invalidateCardTiles, queryCatalogue, userMarks } from './catalogue';

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	db.exec(SCHEMA_SQL);
	db.prepare('INSERT INTO users (id, google_id, email, name) VALUES (?, ?, ?, ?)').run('me', 'me', 'me@example.com', 'me');
});
afterEach(() => db.close());

function card(id: string, oracle: string | null, name: string, set: string, extra: Record<string, unknown> = {}) {
	const row = { id, oracle_id: oracle, name, set_code: set, set_name: `Set ${set}`, layout: 'normal', is_paper: 1,
		image_uri: `https://cards.scryfall.io/normal/front/a/b/${id}.jpg`, price_eur: 1, released_at: '2020-01-01', ...extra };
	db.prepare(`INSERT INTO cards (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(k => '@' + k).join(',')})`).run(row);
}
const ids = (rows: Array<Record<string, unknown>>) => rows.map(r => r.id);
const query = (conditions: string[] = [], params: (string | number)[] = [], printings = false, orderBy = 'cards.name ASC') =>
	queryCatalogue(db, { conditions, params, printings, printingConditions: conditions.some(c => c.includes('set_code')),
		orderBy, limit: 40, offset: 0 });

describe('queryCatalogue', () => {
	beforeEach(() => {
		// Bolt: the newest printing has no image, the one before it no price, the oldest both.
		card('b-new', 'bolt', 'Lightning Bolt', 'new', { released_at: '2024-01-01', image_uri: null });
		card('b-mid', 'bolt', 'Lightning Bolt', 'mid', { released_at: '2022-01-01', price_eur: null });
		card('b-old', 'bolt', 'Lightning Bolt', 'old', { released_at: '2010-01-01' });
		card('b-set', 'bolt', 'Lightning Bolt', 'tst', { released_at: '2005-01-01' });
		card('c-1', 'counter', 'Counterspell', 'old', { released_at: '2010-01-01' });
		card('c-2', 'counter', 'Counterspell', 'new', { released_at: '2024-01-01' });
		card('r-1', null, 'Reversible Thing', 'tst');
	});

	it('lists one tile per card, the card page printing among them', () => {
		const { total, rows } = query();
		expect(total).toBe(3);
		expect(ids(rows)).toEqual(['c-2', 'b-old', 'r-1']);
	});

	it('picks the tile within the filtered rows, so a set filter keeps every card of the set', () => {
		const { total, rows } = query(['cards.set_code = ?'], ['tst']);
		expect(total).toBe(2);
		expect(ids(rows)).toEqual(['b-set', 'r-1']);
	});

	it('keeps the precomputed tiles for card-level filters and follows a new card', () => {
		expect(ids(query(['cards.name = ?'], ['Counterspell']).rows)).toEqual(['c-2']);
		card('c-3', 'counter', 'Counterspell', 'newer', { released_at: '2025-01-01' });
		expect(ids(query(['cards.name = ?'], ['Counterspell']).rows)).toEqual(['c-3']);
		db.prepare("UPDATE cards SET price_eur = NULL WHERE id = 'c-3'").run();
		expect(ids(query(['cards.name = ?'], ['Counterspell']).rows)).toEqual(['c-3']);
		invalidateCardTiles(db);
		expect(ids(query(['cards.name = ?'], ['Counterspell']).rows)).toEqual(['c-2']);
	});

	it('lists every printing on request', () => {
		const { total, rows } = query([], [], true);
		expect(total).toBe(7);
		expect(ids(rows)).toEqual(['c-1', 'c-2', 'b-mid', 'b-new', 'b-old', 'b-set', 'r-1']);
	});

	it('sorts cards by the tile printing and pages them', () => {
		const sorted = queryCatalogue(db, { conditions: [], params: [], printings: false, printingConditions: false,
			orderBy: 'cards.released_at DESC', limit: 2, offset: 1 });
		expect(ids(sorted.rows)).toEqual(['r-1', 'b-old']);
		expect(sorted.total).toBe(3);
	});
});

describe('userMarks', () => {
	it('marks a card tile when any printing of the card is owned, a printing tile only for itself', () => {
		card('p-1', 'o', 'Card', 'a'); card('p-2', 'o', 'Card', 'b'); card('q-1', 'q', 'Other', 'a');
		db.prepare("INSERT INTO collection_cards (user_id, card_id, quantity, condition, foil, language) VALUES ('me', 'p-2', 1, 'NM', 0, 'en')").run();
		db.prepare("INSERT INTO wishlist_cards (user_id, card_id, priority) VALUES ('me', 'q-1', 1)").run();
		const tiles = [{ id: 'p-1', oracle_id: 'o' }, { id: 'q-1', oracle_id: 'q' }];
		const cards = userMarks(db, 'me', tiles, false);
		expect([...cards.collected]).toEqual(['p-1']);
		expect([...cards.wishlist]).toEqual(['q-1']);
		const printings = userMarks(db, 'me', tiles, true);
		expect([...printings.collected]).toEqual([]);
		expect([...printings.wishlist]).toEqual(['q-1']);
		expect(userMarks(db, 'someone', tiles, false).collected.size).toBe(0);
	});
});
