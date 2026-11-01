import { describe, expect, it } from 'vitest';
import type { MarketPoint } from './home';
import { axisDate, marketHref, marketMonths, marketPeriod, marketSeo, marketSeries, monthLabel, parseMarketFilter, pointsInFilter } from './market-history';

const point = (date: string, value: number, printings: number, moved: number): MarketPoint => ({ date, value, printings, moved });
const days = [
	point('2026-09-29', 1000, 10, 7), // its move is against an update outside the list
	point('2026-09-30', 1010, 10, 10),
	point('2026-10-02', 1100, 12, 60), // two new printings: the total rose by 90, the like-for-like move is 60
	point('2026-10-31', 1080, 12, -20),
	point('2026-11-01', 1081, 11, 3)
];
const filterOf = (query: string, currency: 'EUR' | 'USD' = 'EUR') => parseMarketFilter(new URLSearchParams(query), { currency, today: '2026-11-01' });

describe('parseMarketFilter', () => {
	it('shows everything in the viewer\'s market by default', () => {
		expect(filterOf('')).toEqual({ currency: 'EUR', set: null, range: 'all', view: 'value', from: null, to: null });
		expect(filterOf('', 'USD').currency).toBe('USD');
	});

	it('reads a named range from today', () => {
		expect(filterOf('range=30d')).toMatchObject({ range: '30d', from: '2026-10-02', to: null });
		expect(filterOf('range=1y')).toMatchObject({ range: '1y', from: '2025-11-01' });
	});

	it('lets dates win over a range, swaps reversed dates and ignores what is no date', () => {
		expect(filterOf('range=30d&from=2026-10-01')).toMatchObject({ range: 'custom', from: '2026-10-01', to: null });
		expect(filterOf('from=2026-10-31&to=2026-10-01')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
		expect(filterOf('from=2026-02-31&to=soon')).toMatchObject({ range: 'all', from: null, to: null });
	});

	it('falls back on unknown values', () => {
		expect(filterOf('range=week&view=pie&currency=GBP', 'USD')).toEqual({ currency: 'USD', set: null, range: 'all', view: 'value', from: null, to: null });
		expect(filterOf('currency=usd&view=change')).toMatchObject({ currency: 'USD', view: 'change' });
	});

	it('reads a set code, in lower case, and keeps it only when the set is known', () => {
		const sets = new Set(['ltr', 'm10']);
		const read = (query: string) => parseMarketFilter(new URLSearchParams(query), { currency: 'EUR', today: '2026-11-01', sets });
		expect(read('set=LTR&range=90d')).toMatchObject({ set: 'ltr', range: '90d' });
		expect(read('set=xyz').set).toBeNull();
		expect(read('set=ltr%27--').set).toBeNull();
		expect(read('set=').set).toBeNull();
		expect(filterOf('set=m10').set).toBe('m10'); // without a list every well-formed code passes
	});
});

describe('marketHref and marketSeo', () => {
	const base = { currency: 'EUR', set: null, range: 'all', view: 'value', from: null, to: null } as const;

	it('keeps defaults out of the URL, relative to the viewer', () => {
		expect(marketHref(base, 'EUR')).toBe('/market-value');
		expect(marketHref(base, 'USD')).toBe('/market-value?currency=EUR');
		expect(marketHref({ ...base, range: '90d', view: 'change' }, 'EUR')).toBe('/market-value?range=90d&view=change');
		expect(marketHref({ ...base, range: 'custom', from: '2026-10-01', to: '2026-10-31' }, 'EUR')).toBe('/market-value?from=2026-10-01&to=2026-10-31');
		expect(marketHref({ ...base, set: 'ltr', range: '30d' }, 'EUR')).toBe('/market-value?set=ltr&range=30d');
	});

	it('indexes only the page without filters', () => {
		expect(marketSeo(new URLSearchParams(''))).toEqual({ canonical: 'https://mtg-collector.com/market-value', noindex: false });
		expect(marketSeo(new URLSearchParams('from=&to='))).toMatchObject({ noindex: false });
		expect(marketSeo(new URLSearchParams('range=30d&utm_source=x'))).toEqual({ canonical: 'https://mtg-collector.com/market-value?range=30d', noindex: true });
		expect(marketSeo(new URLSearchParams('set=ltr'))).toEqual({ canonical: 'https://mtg-collector.com/market-value?set=ltr', noindex: true });
	});
});

describe('pointsInFilter', () => {
	it('keeps the days between both limits', () => {
		expect(pointsInFilter(days, { from: '2026-09-30', to: '2026-10-31' }).map(p => p.date)).toEqual(['2026-09-30', '2026-10-02', '2026-10-31']);
		expect(pointsInFilter(days, { from: null, to: null })).toHaveLength(5);
	});
});

describe('marketPeriod', () => {
	it('takes the first day as the baseline and compares like for like', () => {
		expect(marketPeriod(days)).toEqual({ from: '2026-09-29', to: '2026-11-01', value: 1081, printings: 11, change: 53, changePct: 5.3,
			newPrintings: 1, high: 1100, low: 1000, updates: 5 });
	});

	it('has no change for one day and nothing without a day', () => {
		expect(marketPeriod([days[0]])).toMatchObject({ change: null, changePct: null, newPrintings: 0, updates: 1 });
		expect(marketPeriod([])).toBeNull();
	});
});

describe('marketMonths', () => {
	it('lists the months newest first with the last value of each', () => {
		const months = marketMonths(days);
		expect(months.map(m => m.month)).toEqual(['2026-11', '2026-10', '2026-09']);
		expect(months[1]).toEqual({ month: '2026-10', value: 1080, lastDate: '2026-10-31', printings: 12, change: 40, changePct: 3.96,
			newPrintings: 2, high: 1100, low: 1080, updates: 2 });
	});

	it('leaves the first day out as the baseline, so the months add up to the period', () => {
		const months = marketMonths(days);
		expect(months[2]).toMatchObject({ change: 10, changePct: 1, updates: 2 });
		expect(months.reduce((sum, m) => sum + (m.change ?? 0), 0)).toBe(marketPeriod(days)!.change);
	});

	it('has no change for a first month of one day', () => {
		expect(marketMonths([days[2], days[3]]).at(-1)).toMatchObject({ month: '2026-10', change: -20 });
		expect(marketMonths([days[3], days[4]]).at(-1)).toMatchObject({ month: '2026-10', change: null, changePct: null, newPrintings: 0 });
		expect(marketMonths([])).toEqual([]);
	});
});

describe('marketSeries', () => {
	it('gives every calendar day a slot, empty where no update ran', () => {
		const { dates, values } = marketSeries(days.slice(0, 3), 'value');
		expect(dates).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
		expect(values).toEqual([1000, 1010, null, 1100]);
	});

	it('picks the view and leaves the baseline out of the changes', () => {
		expect(marketSeries(days.slice(0, 2), 'change').values).toEqual([null, 10]);
		expect(marketSeries(days.slice(0, 2), 'printings').values).toEqual([10, 10]);
		expect(marketSeries([], 'value')).toEqual({ dates: [], values: [] });
	});
});

describe('labels', () => {
	it('reads dates without the time zone moving them', () => {
		expect(monthLabel('2026-10')).toBe('October 2026');
		expect(axisDate('2026-10-31', false)).toBe('Oct 31');
		expect(axisDate('2026-01-01', true)).toBe('Jan 1, 2026');
	});
});
