import { describe, expect, it } from 'vitest';
import { chartPaths, collectionMoves, dashboardSummary, euro, movesHeading, pickMovers, type MoverRow } from './home';

const row = (oracle: string, now: number, prev: number, extra: Partial<MoverRow> = {}): MoverRow => ({
	oracle_id: oracle, name: oracle, set_code: 'tst', now, usd: now, prev, prevUsd: prev, ...extra
});

describe('pickMovers', () => {
	it('splits rises and falls, largest change first', () => {
		const moves = pickMovers([row('a', 11, 10), row('b', 15, 10), row('c', 8, 10), row('d', 9, 10)], { rate: 1 });
		expect(moves.up.map(m => [m.oracleId, m.pct])).toEqual([['b', 50], ['a', 10]]);
		expect(moves.down.map(m => [m.oracleId, m.pct])).toEqual([['c', -20], ['d', -10]]);
		expect(moves.up[0]).toMatchObject({ name: 'b', setCode: 'TST', price: 15 });
	});
	it('drops cheap cards, unchanged prices and rows without a previous price', () => {
		const moves = pickMovers([row('cheap', 1.5, 3), row('was cheap', 4, 1.9), row('flat', 5, 5),
			row('new', 5, null as unknown as number)], { rate: 1 });
		expect([...moves.up, ...moves.down]).toEqual([]);
	});
	it('drops prices that disagree with the USD price by more than a factor of two, now or before', () => {
		const moves = pickMovers([
			row('anomaly now', 300, 30, { usd: 30 }),
			row('anomaly before', 40, 10, { prevUsd: 40 }),
			row('no usd', 40, 20, { usd: null }),
			row('fine', 40, 20, { usd: 50, prevUsd: 22 })
		], { rate: 0.8 });
		expect(moves.up.map(m => m.oracleId)).toEqual(['fine']);
	});
	it('lists every card once, by its largest move', () => {
		const moves = pickMovers([row('bolt', 12, 10, { set_code: 'm10' }), row('bolt', 6, 10, { set_code: 'lea' }),
			row('ring', 11, 10)], { rate: 1 });
		expect(moves.up.map(m => m.oracleId)).toEqual(['ring']);
		expect(moves.down).toMatchObject([{ oracleId: 'bolt', setCode: 'LEA', pct: -40 }]);
	});
	it('keeps at most the limit per direction', () => {
		const rows = Array.from({ length: 8 }, (_, i) => row(`c${i}`, 10 + i + 1, 10));
		expect(pickMovers(rows, { rate: 1, limit: 5 }).up).toHaveLength(5);
	});
});

const holding = (id: string, price: number | null, prev: number | null, extra: Record<string, unknown> = {}) => ({
	id, name: id, quantity: 1, foil: 0, language: 'en', price, price_usd: null, prev_price: prev, prev_price_usd: null, ...extra
});

describe('collectionMoves', () => {
	it('lists the biggest rises and falls of the collection from €1', () => {
		const moves = collectionMoves([holding('a', 12, 10), holding('b', 5, 10), holding('c', 0.8, 0.5),
			holding('d', 3, 3), holding('e', 2, null)], 1);
		expect(moves.up.map(m => [m.id, m.pct])).toEqual([['a', 20]]);
		expect(moves.down.map(m => [m.id, m.pct])).toEqual([['b', -50]]);
	});
	it('converts USD prices and shows each printing, finish and language once', () => {
		const moves = collectionMoves([holding('u', null, null, { price_usd: 20, prev_price_usd: 10 }),
			holding('u', null, null, { price_usd: 20, prev_price_usd: 10 }),
			holding('u', null, null, { foil: 1, price_usd: 30, prev_price_usd: 20 })], 0.5);
		expect(moves.up.map(m => [m.id, m.foil, m.price, m.pct])).toEqual([['u', 0, 10, 100], ['u', 1, 15, 50]]);
	});
});

describe('dashboardSummary', () => {
	const data = (topCards: ReturnType<typeof holding>[], stats: Record<string, number> = {}) => ({
		topCards, usdToEur: 0.5, proxyCopies: 2,
		stats: { totalValue: 100, totalPurchaseValue: 0, profitValue: 60, profitCost: 40, profitCopies: 3,
			uniqueCards: 4, totalCards: 9, ...stats }
	});
	it('reports value, today\'s change, profit and card counts', () => {
		expect(dashboardSummary(data([holding('a', 12, 10, { quantity: 2 }),
			holding('b', null, null, { price_usd: 8, prev_price_usd: 10 }), holding('c', 5, null)])))
			.toEqual({ value: 100, change: 3, profit: 20, profitPct: 50, cards: 9, printings: 4, proxies: 2 });
	});
	it('has no change without earlier prices and no profit without purchase prices', () => {
		expect(dashboardSummary(data([holding('c', 5, null)], { profitCopies: 0, profitValue: 0, profitCost: 0 })))
			.toMatchObject({ change: null, profit: null, profitPct: null });
	});
});

describe('chartPaths', () => {
	const point = (recorded_at: string, total_value: number | null, total_purchase: number | null) =>
		({ recorded_at, total_value, total_purchase });
	it('needs two points', () => {
		expect(chartPaths([point('2026-10-01', 10, 5)], { today: '2026-10-01' })).toBeNull();
		expect(chartPaths([], { today: '2026-10-01' })).toBeNull();
	});
	it('spans the width by date and puts higher values higher', () => {
		const chart = chartPaths([point('2026-10-01', 10, 10), point('2026-10-03', 20, 10), point('2026-10-05', 30, 10)],
			{ today: '2026-10-05', width: 100, height: 100 });
		expect(chart).not.toBeNull();
		const xs = chart!.value.match(/[ML]([\d.]+),/g)!.map(s => Number(s.slice(1, -1)));
		const ys = chart!.value.match(/,([\d.]+)/g)!.map(s => Number(s.slice(1)));
		expect(xs).toEqual([0, 50, 100]);
		expect(ys[0]).toBeGreaterThan(ys[1]);
		expect(ys[1]).toBeGreaterThan(ys[2]);
		expect(chart!.cost.startsWith('M0,')).toBe(true);
		expect(chart).toMatchObject({ first: { value: 10, cost: 10 }, last: { value: 30, cost: 10 } });
	});
	it('starts at the window edge with the last value before it and skips gaps', () => {
		const chart = chartPaths([point('2026-06-01', 10, 8), point('2026-09-01', null, null), point('2026-10-01', 20, 8)],
			{ today: '2026-10-01', days: 90, width: 90, height: 100 });
		expect(chart!.value.match(/[ML]/g)).toHaveLength(2);
		expect(chart!.value.startsWith('M0,')).toBe(true);
		expect(chart!.first).toMatchObject({ date: '2026-07-03', value: 10 });
	});
});

describe('movesHeading', () => {
	it('names the update day, or the span when updates were missed', () => {
		expect(movesHeading('2026-10-09', '2026-10-08')).toBe('Price moves on October 9');
		expect(movesHeading('2026-10-09', '2026-10-07')).toBe('Price moves on October 9');
		expect(movesHeading('2026-09-16', '2026-06-21')).toBe('Price moves from June 21 to September 16');
		expect(movesHeading('2026-09-16', null)).toBe('Price moves on September 16');
	});
});

describe('euro', () => {
	it('groups thousands and keeps two decimals', () => {
		expect(euro(1248.3)).toBe('€1,248.30');
		expect(euro(0)).toBe('€0.00');
	});
});
