import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from './schema-sql';
import { MARKET_VALUE_SQL, marketValueHistory, rebuildMarketValue, updateMarketValue, type MarketValueDay } from './market-value';

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	db.pragma('foreign_keys = OFF'); // price rows without card rows keep the fixtures short
	db.exec(SCHEMA_SQL);
	db.exec(MARKET_VALUE_SQL);
	db.exec('CREATE UNIQUE INDEX idx_price_history_card_snapshot_lang ON price_history(card_id, snapshot_date, language)'); // migration 0018
});
afterEach(() => db.close());

type Prices = { eur?: number | null; eurFoil?: number | null; usd?: number | null; usdFoil?: number | null };
function snap(id: string, day: string, p: Prices, language = 'en') {
	db.prepare(`INSERT INTO price_history (card_id, language, snapshot_date, recorded_at, price_eur, price_eur_foil, price_usd, price_usd_foil)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(card_id, snapshot_date, language) DO UPDATE SET price_eur = excluded.price_eur,
			price_eur_foil = excluded.price_eur_foil, price_usd = excluded.price_usd, price_usd_foil = excluded.price_usd_foil`)
		.run(id, language, day, `${day}T18:00:00Z`, p.eur ?? null, p.eurFoil ?? null, p.usd ?? null, p.usdFoil ?? null);
}
const stored = () => marketValueHistory(db, '');

/** The same figures the slow way: every printing's latest row up to each day. */
function bruteForce(): MarketValueDay[] {
	const dates = (db.prepare("SELECT DISTINCT snapshot_date FROM price_history WHERE language = 'en' ORDER BY 1").pluck().all() as string[]);
	const at = (date: string) => db.prepare(`SELECT p.card_id, COALESCE(p.price_eur, p.price_eur_foil) AS eur, COALESCE(p.price_usd, p.price_usd_foil) AS usd
		FROM price_history p WHERE p.language = 'en' AND p.snapshot_date = (SELECT MAX(q.snapshot_date) FROM price_history q
			WHERE q.card_id = p.card_id AND q.language = 'en' AND q.snapshot_date <= ?)`).all(date) as Array<{ card_id: string; eur: number | null; usd: number | null }>;
	let prev: Map<string, { eur: number | null; usd: number | null }> | null = null;
	const round = (n: number) => Math.round(n * 100) / 100;
	return dates.map(date => {
		const now = new Map(at(date).map(r => [r.card_id, r]));
		let eur = 0, usd = 0, eurN = 0, usdN = 0, eurMoved = 0, usdMoved = 0;
		for (const [id, r] of now) {
			if (r.eur != null) { eur += r.eur; eurN++; }
			if (r.usd != null) { usd += r.usd; usdN++; }
			const before = prev?.get(id);
			if (before?.eur != null && r.eur != null) eurMoved += r.eur - before.eur;
			if (before?.usd != null && r.usd != null) usdMoved += r.usd - before.usd;
		}
		prev = now;
		return { snapshot_date: date, eur: round(eur), eur_printings: eurN, eur_moved: round(eurMoved),
			usd: round(usd), usd_printings: usdN, usd_moved: round(usdMoved) };
	});
}

function history() {
	snap('bolt', '2026-10-01', { eur: 1.5, eurFoil: 4, usd: 2, usdFoil: 5 });
	snap('ring', '2026-10-01', { eur: 100, usd: 120 });
	snap('promo', '2026-10-01', { eurFoil: 10, usdFoil: 12 }); // exists only in foil
	snap('ring', '2026-10-02', { eur: 110, usd: 118 });
	snap('new', '2026-10-02', { eur: 7, usd: 8 }); // first priced: new, not a move
	snap('bolt', '2026-10-04', { eur: 1, eurFoil: 4, usd: null, usdFoil: 5 }); // lost its non-foil USD price: foil counts
	snap('ring', '2026-10-04', { eur: 90, usd: 118 }, 'de'); // other languages are not part of it
}

describe('rebuildMarketValue', () => {
	it('sums one copy of every English printing per update day and the like-for-like move', () => {
		history();
		expect(rebuildMarketValue(db)).toEqual({ days: 3, rows: 6 });
		expect(stored()).toEqual([
			{ snapshot_date: '2026-10-01', eur: 111.5, eur_printings: 3, eur_moved: 0, usd: 134, usd_printings: 3, usd_moved: 0 },
			{ snapshot_date: '2026-10-02', eur: 128.5, eur_printings: 4, eur_moved: 10, usd: 140, usd_printings: 4, usd_moved: -2 },
			{ snapshot_date: '2026-10-04', eur: 128, eur_printings: 4, eur_moved: -0.5, usd: 143, usd_printings: 4, usd_moved: 3 }
		]);
		expect(stored()).toEqual(bruteForce());
	});

	it('leaves the table empty without a price history', () => {
		expect(rebuildMarketValue(db)).toEqual({ days: 0, rows: 0 });
		expect(stored()).toEqual([]);
	});

	it('matches the slow computation on a random history', () => {
		let seed = 7;
		const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
		const days = Array.from({ length: 12 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
		for (const day of days) for (let c = 0; c < 40; c++) {
			if (rand() < 0.55) continue;
			const price = () => (rand() < 0.2 ? null : Math.round(rand() * 5000) / 100);
			snap(`c${c}`, day, { eur: price(), eurFoil: price(), usd: price(), usdFoil: price() });
		}
		rebuildMarketValue(db);
		expect(stored()).toEqual(bruteForce());
	});
});

describe('updateMarketValue', () => {
	it('builds the table on the first call and then extends it day by day like a rebuild', () => {
		snap('bolt', '2026-10-01', { eur: 1.5, usd: 2 });
		snap('ring', '2026-10-01', { eur: 100, usd: 120 });
		expect(updateMarketValue(db)).toEqual({ mode: 'rebuilt', days: 1 });

		snap('ring', '2026-10-02', { eur: 110, usd: 118 });
		snap('new', '2026-10-02', { eur: 7, usd: 8 });
		expect(updateMarketValue(db)).toEqual({ mode: 'extended', days: 2 });
		snap('bolt', '2026-10-05', { eur: 2, usd: 2.5 });
		expect(updateMarketValue(db)).toEqual({ mode: 'extended', days: 2 });
		expect(stored()).toEqual(bruteForce());
		expect(stored().map(d => d.snapshot_date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-05']);
	});

	it('computes the latest day again after a second price run on the same day', () => {
		snap('ring', '2026-10-01', { eur: 100, usd: 120 });
		snap('ring', '2026-10-02', { eur: 110, usd: 118 });
		updateMarketValue(db);
		snap('ring', '2026-10-02', { eur: 95, usd: 118 });
		snap('bolt', '2026-10-02', { eur: 1, usd: 1 });
		expect(updateMarketValue(db)).toEqual({ mode: 'extended', days: 1 });
		expect(stored()).toEqual(bruteForce());
		expect(stored().at(-1)).toMatchObject({ eur: 96, eur_printings: 2, eur_moved: -5 });
	});

	it('rebuilds when a day was written into the past (backfill)', () => {
		snap('ring', '2026-10-01', { eur: 100, usd: 120 });
		snap('ring', '2026-10-05', { eur: 120, usd: 130 });
		updateMarketValue(db);
		snap('ring', '2026-10-03', { eur: 140, usd: 150 });
		snap('ring', '2026-10-06', { eur: 125, usd: 130 });
		expect(updateMarketValue(db)).toEqual({ mode: 'rebuilt', days: 4 });
		expect(stored()).toEqual(bruteForce());
		expect(stored().find(d => d.snapshot_date === '2026-10-05')).toMatchObject({ eur: 120, eur_moved: -20 });
	});

	it('does nothing harmful without any price history', () => {
		expect(updateMarketValue(db)).toEqual({ mode: 'rebuilt', days: 0 });
		expect(updateMarketValue(db)).toEqual({ mode: 'rebuilt', days: 0 });
	});
});

describe('marketValueHistory', () => {
	it('returns the stored days from a date on, oldest first', () => {
		history();
		rebuildMarketValue(db);
		expect(marketValueHistory(db, '2026-10-02').map(d => d.snapshot_date)).toEqual(['2026-10-02', '2026-10-04']);
	});
});
