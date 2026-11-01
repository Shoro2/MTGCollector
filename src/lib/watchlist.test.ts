import { describe, expect, it } from 'vitest';
import {
	change, cleanListName, formatPercent, parseWatchSort, priceRefs, rowAsOf, rowAtTime, rowMarket, sortWatchRows, sparkline, targetReached,
	watchRow, watchTotals, type PriceRow, type WatchEntry
} from './watchlist';

const row = (date: string, eur: number | null, usd: number | null = null, foil: [number | null, number | null] = [null, null], at?: string): PriceRow => ({
	snapshot_date: date, recorded_at: at ?? `${date}T18:05:00Z`, price_eur: eur, price_usd: usd, price_eur_foil: foil[0], price_usd_foil: foil[1]
});

const entry = (over: Partial<WatchEntry> = {}): WatchEntry => ({
	id: 1, list_id: 1, card_id: 'bolt', foil: 0, target_price: null, target_currency: 'EUR', target_direction: 'below', notes: '',
	added_at: '2026-10-20T12:00:00Z', name: 'Lightning Bolt', set_code: 'clu', set_name: 'Clue', collector_number: '141', rarity: 'common',
	image_uri: null, local_image_path: null, mana_cost: '{R}', price_eur: 2, price_eur_foil: 5, price_usd: 2.5, price_usd_foil: null, ...over
});

describe('reference days and lookups', () => {
	it('derives week and month from the latest update', () => {
		expect(priceRefs('2026-11-01', '2026-10-31')).toEqual({ latest: '2026-11-01', previous: '2026-10-31', week: '2026-10-25', month: '2026-10-02' });
		expect(priceRefs(null, null)).toEqual({ latest: null, previous: null, week: null, month: null });
	});

	it('carries the last row forward to a date and to a moment', () => {
		const rows = [row('2026-10-01', 1), row('2026-10-10', 2), row('2026-10-20', 3)];
		expect(rowAsOf(rows, '2026-09-30')).toBeNull();
		expect(rowAsOf(rows, '2026-10-15')?.price_eur).toBe(2);
		expect(rowAsOf(rows, '2026-10-20')?.price_eur).toBe(3);
		expect(rowAsOf(rows, null)).toBeNull();
		// Added on Oct 20 at 12:00, before that day's 18:05 update: the price then was Oct 10's.
		expect(rowAtTime(rows, '2026-10-20T12:00:00Z')?.price_eur).toBe(2);
		expect(rowAtTime(rows, '2026-10-20T19:00:00Z')?.price_eur).toBe(3);
		expect(rowAtTime([{ ...row('2026-10-01', 7), recorded_at: null }], '2026-10-02T00:00:00Z')?.price_eur).toBe(7);
		expect(rowAtTime(rows, 'not a date')).toBeNull();
	});

	it('shows the chosen market, else the other one, never both missing as zero', () => {
		expect(rowMarket({ eur: 1, usd: 2 }, 'USD')).toBe('USD');
		expect(rowMarket({ eur: 1, usd: null }, 'USD')).toBe('EUR');
		expect(rowMarket({ eur: null, usd: null }, 'EUR')).toBeNull();
	});
});

describe('changes and targets', () => {
	it('measures amount and percent, gaps stay null', () => {
		expect(change(3, 2)).toEqual({ amount: 1, percent: 50 });
		expect(change(2, 2)).toEqual({ amount: 0, percent: 0 });
		expect(change(1, 0)).toEqual({ amount: 1, percent: null });
		expect(change(null, 2)).toBeNull();
		expect(change(2, null)).toBeNull();
	});

	it('compares a target with its own market only', () => {
		expect(targetReached({ eur: 9, usd: 20 }, 10, 'EUR', 'below')).toBe(true);
		expect(targetReached({ eur: 11, usd: 5 }, 10, 'EUR', 'below')).toBe(false);
		expect(targetReached({ eur: 11, usd: null }, 10, 'USD', 'below')).toBeNull();
		expect(targetReached({ eur: 11, usd: null }, 10, 'EUR', 'above')).toBe(true);
		expect(targetReached({ eur: 11, usd: null }, null, 'EUR', 'above')).toBeNull();
	});

	it('formats percents with a sign', () => {
		expect(formatPercent(4.21)).toBe('+4.2%');
		expect(formatPercent(-1)).toBe('−1.0%');
		expect(formatPercent(0.01)).toBe('0%');
		expect(formatPercent(250)).toBe('+250%');
		expect(formatPercent(null)).toBe('');
	});
});

describe('watchRow', () => {
	const rows = [row('2026-09-01', 1, 1.2), row('2026-10-15', 1.5, 2), row('2026-10-31', 1.8, 2.4), row('2026-11-01', 2, 2.5)];
	const refs = priceRefs('2026-11-01', '2026-10-31');

	it('prices the row in euros with every change', () => {
		const r = watchRow(entry(), rows, refs, 'EUR');
		expect(r.market).toBe('EUR');
		expect(r.price).toBe(2);
		expect(r.otherMarket).toBe(false);
		expect(r.day?.amount).toBeCloseTo(0.2);
		expect(r.week?.amount).toBeCloseTo(0.5); // Oct 25 carries Oct 15's 1.5
		expect(r.month?.amount).toBeCloseTo(1); // Oct 2 carries Sep 1's 1
		expect(r.addedPrice).toBe(1.5); // in effect on Oct 20 at noon
		expect(r.sinceAdded?.percent).toBeCloseTo(33.33, 1);
		expect(r.spark?.rising).toBe(true);
	});

	it('uses the dollar market for an account in dollars', () => {
		const r = watchRow(entry(), rows, refs, 'USD');
		expect(r.market).toBe('USD');
		expect(r.price).toBe(2.5);
		expect(r.day?.amount).toBeCloseTo(0.1);
	});

	it('falls back to the other market for the whole row, never converting', () => {
		const foilRows = [row('2026-10-31', null, null, [4, null]), row('2026-11-01', null, null, [5, null])];
		const r = watchRow(entry({ foil: 1 }), foilRows, refs, 'USD');
		expect(r.market).toBe('EUR');
		expect(r.otherMarket).toBe(true);
		expect(r.price).toBe(5);
		expect(r.day).toEqual({ amount: 1, percent: 25 });
	});

	it('leaves an unpriced row as a gap', () => {
		const r = watchRow(entry({ price_eur: null, price_usd: null }), rows, refs, 'EUR');
		expect(r.market).toBeNull();
		expect(r.price).toBeNull();
		expect(r.day).toBeNull();
		expect(r.spark).toBeNull();
	});

	it('marks a reached target', () => {
		expect(watchRow(entry({ target_price: 2, target_direction: 'below' }), rows, refs, 'EUR').target).toBe(true);
		expect(watchRow(entry({ target_price: 2.4, target_currency: 'USD', target_direction: 'above' }), rows, refs, 'EUR').target).toBe(true);
	});
});

describe('sparkline', () => {
	it('carries the price before the window and to the end', () => {
		const s = sparkline([row('2026-01-01', 1), row('2026-10-01', 3)], false, 'EUR', '2026-11-01', { days: 90, width: 90, height: 32 })!;
		expect(s.low).toBe(1);
		expect(s.high).toBe(3);
		expect(s.path.startsWith('M0,30')).toBe(true);
		expect(s.path.endsWith('L90,2')).toBe(true);
		expect(s.rising).toBe(true);
	});

	it('draws a flat line for an unchanged price and nothing without a price', () => {
		expect(sparkline([row('2026-01-01', 1)], false, 'EUR', '2026-11-01')?.rising).toBeNull();
		expect(sparkline([row('2026-01-01', null)], false, 'EUR', '2026-11-01')).toBeNull();
		expect(sparkline([], false, 'EUR', null)).toBeNull();
	});
});

describe('sorting and totals', () => {
	const refs = priceRefs('2026-11-01', '2026-10-31');
	const make = (id: number, name: string, eur: number | null, usd: number | null, prev: number | null) =>
		watchRow(entry({ id, name, price_eur: eur, price_usd: usd, added_at: `2026-10-0${id}T00:00:00Z` }),
			prev == null ? [] : [row('2026-10-31', prev, prev)], refs, 'EUR');
	const rows = [make(1, 'Alpha', 10, 11, 8), make(2, 'Beta', null, 20, 20), make(3, 'Gamma', null, null, null), make(4, 'Delta', 1, 1, 2)];

	it('sorts by converted price and by percent, gaps last both ways', () => {
		const byPrice = sortWatchRows(rows, 'price', 'desc', 'EUR', 0.9).map((r) => r.name);
		expect(byPrice).toEqual(['Beta', 'Alpha', 'Delta', 'Gamma']);
		expect(sortWatchRows(rows, 'price', 'asc', 'EUR', 0.9).map((r) => r.name)).toEqual(['Delta', 'Alpha', 'Beta', 'Gamma']);
		expect(sortWatchRows(rows, 'day', 'desc', 'EUR', 0.9).map((r) => r.name)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
		expect(sortWatchRows(rows, 'name', 'asc', 'EUR', 0.9).map((r) => r.name)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
		expect(sortWatchRows(rows, 'added', 'desc', 'EUR', 0.9).map((r) => r.id)).toEqual([4, 3, 2, 1]);
	});

	it('converts only the totals', () => {
		const t = watchTotals(rows, 'EUR', 0.9);
		expect(t.value).toBeCloseTo(10 + 18 + 1);
		expect(t.priced).toBe(3);
		expect(t.unpriced).toBe(1);
		expect(t.dayCompared).toBe(3);
		expect(t.dayMove).toBeCloseTo(2 + 0 - 1);
	});

	it('reads sort parameters with safe defaults', () => {
		expect(parseWatchSort(null, null)).toEqual({ sort: 'added', dir: 'desc' });
		expect(parseWatchSort('name', null)).toEqual({ sort: 'name', dir: 'asc' });
		expect(parseWatchSort('day', 'asc')).toEqual({ sort: 'day', dir: 'asc' });
		expect(parseWatchSort('drop table', 'sideways')).toEqual({ sort: 'added', dir: 'desc' });
	});
});

describe('list names', () => {
	it('keeps one trimmed line of 1 to 60 characters', () => {
		expect(cleanListName('  Buy  later\n ')).toBe('Buy later');
		expect(cleanListName('a​b')).toBe('ab');
		expect(cleanListName('')).toBeNull();
		expect(cleanListName('x'.repeat(61))).toBeNull();
		expect(cleanListName(5)).toBeNull();
	});
});
