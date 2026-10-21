import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from './schema-sql';
import { priceMoverRows, printingPriceSample, recentlyAdded, setCodes, wishlistCount } from './home-data';

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	db.exec(SCHEMA_SQL);
	const user = db.prepare('INSERT INTO users (id, google_id, email, name) VALUES (?, ?, ?, ?)');
	for (const id of ['me', 'someone']) user.run(id, id, `${id}@example.com`, id);
});
afterEach(() => db.close());

function card(id: string, oracle: string, name: string, set: string, eur: number | null = null, extra: Record<string, unknown> = {}) {
	const row = { id, oracle_id: oracle, name, set_code: set, set_name: `Set ${set}`, price_eur: eur, price_usd: null,
		price_eur_foil: null, price_usd_foil: null, layout: 'normal', is_paper: 1, ...extra };
	db.prepare(`INSERT INTO cards (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(k => '@' + k).join(',')})`).run(row);
}
function snap(id: string, day: string, eur: number | null, usd: number | null = null, language = 'en') {
	db.prepare('INSERT INTO price_history (card_id, language, snapshot_date, recorded_at, price_eur, price_usd) VALUES (?, ?, ?, ?, ?, ?)')
		.run(id, language, day, `${day}T05:00:00Z`, eur, usd);
}
function own(id: string, user: string, added: string, extra: Record<string, unknown> = {}) {
	const row = { card_id: id, user_id: user, added_at: added, quantity: 1, foil: 0, language: 'en', location: '', proxy: 0, ...extra };
	return db.prepare(`INSERT INTO collection_cards (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(k => '@' + k).join(',')})`)
		.run(row).lastInsertRowid;
}

describe('priceMoverRows', () => {
	it('pairs each printing of the latest snapshot day with its previous snapshot', () => {
		card('p1', 'o1', 'Ring', 'ltr'); card('p2', 'o2', 'Bolt', 'm10'); card('p3', 'o3', 'Cheap', 'm10');
		snap('p1', '2026-10-01', 50, 55); snap('p1', '2026-10-05', 60, 66); snap('p1', '2026-10-09', 70, 77);
		snap('p2', '2026-10-09', 3, 3.3);
		snap('p3', '2026-10-01', 2.5, 2.5); snap('p3', '2026-10-09', 1.5, 1.6);
		snap('p1', '2026-10-09', 900, null, 'de');
		const { date, previousDate, rows } = priceMoverRows(db);
		expect([date, previousDate]).toEqual(['2026-10-09', '2026-10-05']);
		expect(rows).toEqual([
			{ oracle_id: 'o1', name: 'Ring', set_code: 'ltr', now: 70, usd: 77, prev: 60, prevUsd: 66 },
			{ oracle_id: 'o2', name: 'Bolt', set_code: 'm10', now: 3, usd: 3.3, prev: null, prevUsd: null }
		]);
	});
	it('returns nothing without price history', () => {
		expect(priceMoverRows(db)).toEqual({ date: null, previousDate: null, rows: [] });
	});
});

describe('recentlyAdded', () => {
	it('lists the newest entries of one user with location, proxy flag and the price of their language and finish', () => {
		card('a', 'oa', 'Alpha', 'tst', 2, { price_eur_foil: 9 }); card('b', 'ob', 'Beta', 'tst', 4); card('c', 'oc', 'Gamma', 'tst', 6);
		db.prepare("INSERT INTO card_prices_lang (card_id, language, price_eur) VALUES ('b', 'de', 3.5)").run();
		own('a', 'me', '2026-10-01', { foil: 1, location: 'Binder 1' });
		own('b', 'me', '2026-10-03', { language: 'de', quantity: 2 });
		own('c', 'me', '2026-10-02', { proxy: 1, location: 'Deck' });
		own('c', 'someone', '2026-10-09');
		expect(recentlyAdded(db, 'me', 2)).toEqual([
			{ id: expect.any(Number), card_id: 'b', name: 'Beta', set_code: 'tst', quantity: 2, location: '', proxy: 0, foil: 0,
				language: 'de', price: 3.5, price_usd: null },
			{ id: expect.any(Number), card_id: 'c', name: 'Gamma', set_code: 'tst', quantity: 1, location: 'Deck', proxy: 1, foil: 0,
				language: 'en', price: 6, price_usd: null }
		]);
		expect(recentlyAdded(db, 'me', 5).at(-1)).toMatchObject({ card_id: 'a', foil: 1, price: 9, location: 'Binder 1' });
	});
});

describe('wishlistCount', () => {
	it('counts one user\'s wishlist entries', () => {
		card('a', 'oa', 'Alpha', 'tst');
		const add = db.prepare('INSERT INTO wishlist_cards (card_id, user_id) VALUES (?, ?)');
		add.run('a', 'me'); add.run('a', 'me'); add.run('a', 'someone');
		expect(wishlistCount(db, 'me')).toBe(2);
		expect(wishlistCount(db, 'nobody')).toBe(0);
	});
});

describe('printingPriceSample', () => {
	it('shows the cheapest, a middle and the most expensive paper printing of a card', () => {
		card('n1', 'bolt', 'Lightning Bolt', 'fdn', 0.3); card('n2', 'bolt', 'Lightning Bolt', 'm10', 2.9);
		card('n3', 'bolt', 'Lightning Bolt', 'lea', 450); card('n4', 'bolt', 'Lightning Bolt', 'm11', 1.2);
		card('n5', 'bolt', 'Lightning Bolt', 'prm', 99, { is_paper: 0 }); card('n6', 'bolt', 'Lightning Bolt', 'sld', null);
		expect(printingPriceSample(db, 'Lightning Bolt')).toEqual([
			{ set_name: 'Set fdn', price: 0.3 }, { set_name: 'Set m11', price: 1.2 }, { set_name: 'Set lea', price: 450 }
		]);
	});
	it('returns what there is for cards with few printings', () => {
		card('x', 'ox', 'Lightning Bolt', 'fdn', 0.3);
		expect(printingPriceSample(db, 'Lightning Bolt')).toEqual([{ set_name: 'Set fdn', price: 0.3 }]);
		expect(printingPriceSample(db, 'Missing')).toEqual([]);
	});
});

describe('setCodes', () => {
	it('maps printing ids to their set codes', () => {
		card('a', 'oa', 'Alpha', 'ltr'); card('b', 'ob', 'Beta', 'm10');
		expect(setCodes(db, ['a', 'b', 'missing'])).toEqual(new Map([['a', 'ltr'], ['b', 'm10']]));
		expect(setCodes(db, [])).toEqual(new Map());
	});
});
