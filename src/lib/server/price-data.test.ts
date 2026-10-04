import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCardPriceHistory, getPriceData } from './price-data';
import { priceHistoryRange, recentSnapshots, SNAPSHOT_INDEX_SQL } from './admin-stats';

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	db.exec(`CREATE TABLE cards (id TEXT PRIMARY KEY, name TEXT, set_name TEXT, image_uri TEXT, local_image_path TEXT,
		price_eur REAL, price_eur_foil REAL, price_usd REAL, price_usd_foil REAL);
		CREATE TABLE collection_cards (id INTEGER PRIMARY KEY, card_id TEXT, user_id TEXT, quantity INTEGER,
		foil INTEGER, language TEXT, purchase_price REAL, added_at TEXT);
		CREATE TABLE card_prices_lang (card_id TEXT, language TEXT, price_eur REAL, price_eur_foil REAL, price_usd REAL, price_usd_foil REAL);
		CREATE TABLE price_history (id INTEGER PRIMARY KEY, card_id TEXT, language TEXT, snapshot_date TEXT, recorded_at TEXT,
		price_eur REAL, price_eur_foil REAL, price_usd REAL, price_usd_foil REAL);
		CREATE INDEX history_lookup ON price_history(card_id, language, snapshot_date);
		CREATE INDEX history_recorded ON price_history(recorded_at);`);
});
afterEach(() => db.close());

function card(id: string, eur: number | null, usd: number | null = null, foil: number | null = null) {
	db.prepare('INSERT INTO cards VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL)').run(id, id, 'Test', eur, foil, usd);
}
function own(id: string, cost: number | null, quantity = 1, language: string | null = 'en', added = '2026-10-01', foil = 0, user = 'owner') {
	db.prepare('INSERT INTO collection_cards(card_id,user_id,quantity,foil,language,purchase_price,added_at) VALUES (?,?,?,?,?,?,?)')
		.run(id, user, quantity, foil, language, cost, added);
}
function snap(id: string, day: string, eur: number | null, language = 'en', usd: number | null = null, foil: number | null = null, time = '05:00:00') {
	db.prepare('INSERT INTO price_history(card_id,language,snapshot_date,recorded_at,price_eur,price_usd,price_eur_foil) VALUES (?,?,?,?,?,?,?)')
		.run(id, language, day, `${day}T${time}Z`, eur, usd, foil);
}
const result = () => getPriceData(db, 'owner', 0.8, '2026-10-04');

describe('portfolio totals and history', () => {
	it('compares only copies with both prices, counts printings, and keeps users isolated', () => {
		card('a', 10); card('b', 50); card('c', null);
		own('a', 3, 2); own('a', 4); own('b', null, 4); own('c', 80, 2); own('b', 1, 100, 'en', '2026-10-01', 0, 'someone-else');
		const data = result();
		expect(data.stats).toEqual({ totalValue: 230, totalPurchaseValue: 170, profitValue: 30, profitCost: 10,
			profitCopies: 3, uniqueCards: 3, totalCards: 9 });
		expect(data.missingPriceCount).toBe(4);
		expect(data.missingMarketCount).toBe(2);
		expect(data.profitHistory.at(-1)).toMatchObject({ total_value: 30, total_purchase: 10, missing_market_count: 2 });
	});
	it('keeps collection values but returns no profit history without purchase prices', () => {
		card('a', 10); own('a', null, 3); snap('a', '2026-10-02', 9);
		expect(result()).toMatchObject({ missingPriceCount: 3, profitHistory: [], stats: { totalValue: 30, profitCopies: 0 } });
	});
	it('preserves explicit zero costs and zero market prices', () => {
		card('free', 10); card('zero', 0, 9); own('free', 0); own('zero', 5);
		expect(result().stats).toMatchObject({ profitValue: 10, profitCost: 5, profitCopies: 2 });
		expect(result().missingMarketCount).toBe(0);
	});
	it('uses USD conversion and the owned finish consistently', () => {
		card('usd', null, 10, 30); own('usd', 3, 2); own('usd', 20, 1, 'en', '2026-10-01', 1);
		snap('usd', '2026-10-01', null, 'en', 5, 25);
		const data = result();
		expect(data.stats.totalValue).toBe(46);
		expect(data.profitHistory[0]).toMatchObject({ total_value: 33, total_purchase: 26 });
		expect(data.topCards[0]).toMatchObject({ price: null, price_usd: 10, prev_price: null, prev_price_usd: 5 });
	});
	it('uses and marks English reference history for German holdings without a German series', () => {
		card('de', 11); own('de', 8, 2, 'de'); snap('de', '2026-10-01', 10);
		expect(result().profitHistory[0]).toMatchObject({ total_value: 20, total_purchase: 16, estimated_count: 2 });
		expect(result().profitHistory.at(-1)).toMatchObject({ total_value: 22, total_purchase: 16, estimated_count: 2 });
		expect(result().topCards[0]).toMatchObject({ estimated: true, prev_estimated: true, prev_price: 10 });
	});
	it('switches from reference history to the language price only when it becomes available', () => {
		card('de', 11); own('de', 8, 1, 'de'); snap('de', '2026-10-01', 10); snap('de', '2026-10-03', 14, 'de');
		db.prepare('INSERT INTO card_prices_lang VALUES (?, ?, ?, NULL, NULL, NULL)').run('de', 'de', 15);
		const points = result().profitHistory;
		expect(points[0]).toMatchObject({ total_value: 10, estimated_count: 1 });
		expect(points.find(p => p.recorded_at === '2026-10-03')).toMatchObject({ total_value: 14, estimated_count: 0 });
		expect(points.at(-1)).toMatchObject({ total_value: 15, estimated_count: 0 });
	});
	it('does not invent earlier prices or turn missing history into a loss', () => {
		card('later', 20); own('later', 15); snap('later', '2026-10-03', 18);
		expect(result().profitHistory[0]).toMatchObject({ recorded_at: '2026-10-01', total_value: null, total_purchase: null, missing_market_count: 1 });
	});
	it('does not resurrect an old value when a later snapshot has no price', () => {
		card('gone', null); own('gone', 5); snap('gone', '2026-10-01', 10); snap('gone', '2026-10-02', null);
		expect(result().profitHistory.find(p => p.recorded_at === '2026-10-02')).toMatchObject({ total_value: null, total_purchase: null });
	});
	it('adds acquisition dates and today between sparse change-only snapshots', () => {
		card('a', 12); own('a', 6, 2, 'en', '2026-10-02T20:00:00Z'); snap('a', '2026-09-30', 10);
		expect(result().profitHistory).toEqual([
			{ recorded_at: '2026-10-02', total_value: 20, total_purchase: 12, missing_market_count: 0, estimated_count: 0 },
			{ recorded_at: '2026-10-04', total_value: 24, total_purchase: 12, missing_market_count: 0, estimated_count: 0 }
		]);
	});
	it('carries the last price forward for yesterday and handles legacy null language', () => {
		card('a', 12); own('a', 5, 1, null); snap('a', '2026-09-29', 10); snap('a', '2026-10-04', 12);
		expect(result().topCards[0]).toMatchObject({ language: 'en', prev_price: 10, estimated: false });
	});
	it('ignores future price snapshots and matches today to the comparable KPI values', () => {
		card('a', 12); card('b', null); own('a', 5); own('b', 50); snap('a', '2026-10-09', 1000);
		const data = result();
		expect(data.profitHistory.at(-1)?.total_value).toBe(data.stats.profitValue);
		expect(data.profitHistory.at(-1)?.total_purchase).toBe(data.stats.profitCost);
		expect(data.profitHistory.some(p => p.recorded_at > '2026-10-04')).toBe(false);
	});
	it('does not manufacture a 1970 chart point for legacy rows without an added date', () => {
		card('a', 10); own('a', 5); snap('a', '2026-10-02', 8);
		db.exec('UPDATE collection_cards SET added_at = NULL');
		expect(result().profitHistory.map(p => p.recorded_at)).toEqual(['2026-10-02', '2026-10-04']);
	});
});

describe('card chart and admin snapshots', () => {
	it('keeps the canonical day for morning snapshots instead of shifting it backwards', () => {
		snap('a', '2026-10-01', 10, 'en', null, null, '18:00:00'); snap('a', '2026-10-02', 11);
		expect(getCardPriceHistory(db, 'a', 'en').map(p => p.recorded_at)).toEqual(['2026-10-01', '2026-10-02']);
	});
	it('marks per-card language fallback and keeps the last known language quote', () => {
		snap('a', '2026-10-01', 10); snap('a', '2026-10-02', 12, 'de'); snap('a', '2026-10-03', 11);
		expect(getCardPriceHistory(db, 'a', 'de').map(p => [p.price_eur, p.estimated])).toEqual([[10, true], [12, false], [12, false]]);
	});
	it('counts each printing once across languages and limits to the latest ten dates', () => {
		for (let day = 1; day <= 12; day++) snap('a', `2026-09-${String(day).padStart(2, '0')}`, day);
		snap('a', '2026-09-12', 20, 'de'); snap('b', '2026-09-12', 5);
		const before = recentSnapshots(db);
		db.exec(SNAPSHOT_INDEX_SQL); db.exec(SNAPSHOT_INDEX_SQL);
		expect(recentSnapshots(db)).toEqual(before);
		expect(before).toHaveLength(10);
		expect(before[0]).toEqual({ snapshot_date: '2026-09-12', cards_snapshotted: 2 });
		expect(priceHistoryRange(db)).toEqual({ earliest: '2026-09-01T05:00:00Z', latest: '2026-09-12T05:00:00Z' });
	});
});
