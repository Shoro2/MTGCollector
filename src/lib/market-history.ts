import { isCurrency, type Currency } from './currency';
import type { MarketPoint } from './home';
import { SITE_URL } from './seo';

// The detail page of the market value of every printing (/market-value): the filters
// from the URL, the period's figures and the same figures per month. Pure functions;
// the stored days come from $lib/server/market-value.ts.

export const MARKET_RANGES = [
	{ id: '30d', label: '30 days', days: 30 },
	{ id: '90d', label: '90 days', days: 90 },
	{ id: '6m', label: '6 months', days: 183 },
	{ id: '1y', label: '1 year', days: 365 },
	{ id: 'all', label: 'All', days: null }
] as const;
export type MarketRange = (typeof MARKET_RANGES)[number]['id'] | 'custom';

export const MARKET_VIEWS = [
	{ id: 'value', label: 'Market value' },
	{ id: 'change', label: 'Change per update' },
	{ id: 'printings', label: 'Printings priced' }
] as const;
export type MarketView = (typeof MARKET_VIEWS)[number]['id'];

export type MarketFilter = {
	currency: Currency;
	/** One set's printings (cards.set_code, lower case), null: every printing. */
	set: string | null;
	range: MarketRange;
	view: MarketView;
	/** First and last day shown (YYYY-MM-DD), null: no limit. */
	from: string | null;
	to: string | null;
};

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** A real calendar date in YYYY-MM-DD, or null. */
function validDate(value: string | null): string | null {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const day = dayNumber(value);
	return Number.isFinite(day) && dateOf(day) === value ? value : null;
}

/** A set code as Scryfall writes them (lower case letters and digits), or null. */
function setCode(value: string | null): string | null {
	const code = (value ?? '').trim().toLowerCase();
	return /^[a-z0-9]{2,8}$/.test(code) ? code : null;
}

/**
 * The filters from the URL; anything unknown falls back to the default: every
 * printing, all days, the market value, `currency` (the viewer's). Dates win over a
 * named range, and reversed dates are swapped. A set is kept only when `sets`
 * knows it.
 */
export function parseMarketFilter(search: URLSearchParams, { currency, today, sets }: { currency: Currency; today: string; sets?: ReadonlySet<string> }): MarketFilter {
	const asked = (search.get('currency') ?? '').trim().toUpperCase();
	const view = MARKET_VIEWS.find(v => v.id === search.get('view'))?.id ?? 'value';
	const set = setCode(search.get('set'));
	const base = { currency: isCurrency(asked) ? asked : currency, set: set && (!sets || sets.has(set)) ? set : null, view };
	let from = validDate(search.get('from')), to = validDate(search.get('to'));
	if (from || to) {
		if (from && to && from > to) [from, to] = [to, from];
		return { ...base, range: 'custom', from, to };
	}
	const range = MARKET_RANGES.find(r => r.id === search.get('range')) ?? MARKET_RANGES[MARKET_RANGES.length - 1];
	return { ...base, range: range.id, from: range.days == null ? null : dateOf(dayNumber(today) - range.days), to: null };
}

/** The link to the page with these filters; defaults stay out of the URL. */
export function marketHref(filter: Pick<MarketFilter, 'currency' | 'set' | 'range' | 'view' | 'from' | 'to'>, viewerCurrency: Currency): string {
	const params = new URLSearchParams();
	if (filter.set) params.set('set', filter.set);
	if (filter.range === 'custom') {
		if (filter.from) params.set('from', filter.from);
		if (filter.to) params.set('to', filter.to);
	} else if (filter.range !== 'all') params.set('range', filter.range);
	if (filter.currency !== viewerCurrency) params.set('currency', filter.currency);
	if (filter.view !== 'value') params.set('view', filter.view);
	return `/market-value${params.size ? `?${params}` : ''}`;
}

/** Only the page without filters is a landing page; a filtered one keeps its own canonical (as catalogSeo()). */
export function marketSeo(search: URLSearchParams) {
	const params = new URLSearchParams();
	for (const key of ['set', 'range', 'from', 'to', 'currency', 'view']) {
		const value = (search.get(key) ?? '').trim();
		if (value) params.set(key, value);
	}
	return { canonical: `${SITE_URL}/market-value${params.size ? `?${params}` : ''}`, noindex: params.size > 0 };
}

export function pointsInFilter(points: MarketPoint[], filter: Pick<MarketFilter, 'from' | 'to'>): MarketPoint[] {
	return points.filter(p => (!filter.from || p.date >= filter.from) && (!filter.to || p.date <= filter.to));
}

const cents = (n: number) => Math.round(n * 100) / 100;
/**
 * The percent of a like-for-like change: the change against what the printings
 * priced at the end were worth at the start, which is the end total minus the
 * change. A printing priced at the start counts with its price then, one priced
 * later with its first price, because its first day moves nothing and every later
 * move is in the change. So the percent always has the sign of the change and
 * never falls below −100 %. Two earlier formulas did not: the summed moves over the
 * first day's total put printings priced later into the numerator only (SOS on the
 * host, 2026-11-01: −135.79 % for April, +2848.02 % for May), and chaining each
 * update against the total before it weighted a set's early losses on a few
 * printings above its later gains on hundreds (SOS, 2026-11-02: +€938 beside
 * −62.15 %). Null without a change or without a positive base.
 */
function changePctOf(change: number | null, end: number): number | null {
	if (change == null) return null;
	const start = end - change;
	return start > 0 ? Math.round(change / start * 10000) / 100 : null;
}

/**
 * The figures of the days shown. The first day is the baseline, so its own move
 * (against an update outside the view) does not count; the change is like-for-like,
 * as on the homepage, and its percent is taken against the start value of the
 * printings priced at the end (`changePctOf()`). `newPrintings` is the net of
 * printings that gained or lost a price, which the change leaves out. Null without a day.
 */
export function marketPeriod(points: MarketPoint[]) {
	if (!points.length) return null;
	const first = points[0], last = points[points.length - 1];
	const values = points.map(p => p.value);
	const change = points.length > 1 ? cents(points.slice(1).reduce((sum, p) => sum + p.moved, 0)) : null;
	return {
		from: first.date,
		to: last.date,
		value: last.value,
		printings: last.printings,
		change,
		changePct: changePctOf(change, last.value),
		newPrintings: last.printings - first.printings,
		high: Math.max(...values),
		low: Math.min(...values),
		updates: points.length
	};
}

export type MarketMonth = {
	/** YYYY-MM */
	month: string;
	/** The month's last update. */
	value: number;
	lastDate: string;
	printings: number;
	/** Like-for-like change against the update before the month; null for the very first day alone. */
	change: number | null;
	changePct: number | null;
	newPrintings: number;
	high: number;
	low: number;
	updates: number;
};

/**
 * The same days per month, newest first. The months' changes add up to the
 * period's change: each counts the moves of its own updates against the update
 * before, except the very first day shown, which is the baseline.
 */
export function marketMonths(points: MarketPoint[]): MarketMonth[] {
	const months: MarketMonth[] = [];
	let i = 0;
	while (i < points.length) {
		const month = points[i].date.slice(0, 7);
		let end = i;
		while (end + 1 < points.length && points[end + 1].date.slice(0, 7) === month) end++;
		const own = points.slice(i, end + 1);
		const base = i > 0 ? points[i - 1] : points[0];
		const counted = i > 0 ? own : own.slice(1);
		const change = counted.length ? cents(counted.reduce((sum, p) => sum + p.moved, 0)) : null;
		const last = own[own.length - 1];
		const values = own.map(p => p.value);
		months.push({
			month,
			value: last.value,
			lastDate: last.date,
			printings: last.printings,
			change,
			changePct: changePctOf(change, last.value),
			newPrintings: last.printings - base.printings,
			high: Math.max(...values),
			low: Math.min(...values),
			updates: own.length
		});
		i = end + 1;
	}
	return months.reverse();
}

/**
 * The chart's series with one slot per calendar day, null where no update ran, so a
 * missed week takes the width of a week instead of looking like one day.
 */
export function marketSeries(points: MarketPoint[], view: MarketView) {
	const pick = (p: MarketPoint) => view === 'change' ? p.moved : view === 'printings' ? p.printings : p.value;
	if (!points.length) return { dates: [] as string[], values: [] as Array<number | null> };
	const byDate = new Map(points.map(p => [p.date, p]));
	const dates: string[] = [], values: Array<number | null> = [];
	for (let day = dayNumber(points[0].date), end = dayNumber(points[points.length - 1].date); day <= end; day++) {
		const date = dateOf(day), point = byDate.get(date);
		dates.push(date);
		// The first day's move is against an update outside the view (see marketPeriod()).
		values.push(point == null || (view === 'change' && point === points[0]) ? null : pick(point));
	}
	return { dates, values };
}

/** "October 2026" */
export function monthLabel(month: string) {
	return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "October 31, 2026" */
export function longDate(date: string) {
	return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** "Oct 31" for the chart's axis. */
export function axisDate(date: string, withYear: boolean) {
	return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}
