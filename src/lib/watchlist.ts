// Price watchlists (/watchlist): named lists of printings a signed-in user follows
// without owning or wanting them, with the current price and how it moved. Pure
// functions, shared by the server (src/lib/server/watchlists.ts) and the page.
//
// Honest numbers, as everywhere (src/lib/currency.ts): a row's price is the chosen
// market's price of the entry's finish; when that market has none, the other
// market's price is shown with its own symbol and every change of that row is
// measured in that market too, never converted. Only the list's total converts.
// A missing price is a gap, never zero.

import { convertMoney, type Currency } from './currency.js';

export const MAX_LISTS = 20;
export const MAX_ENTRIES = 500;
export const MAX_LIST_NAME = 60;
export const MAX_NOTES = 500;
export const DEFAULT_LIST_NAME = 'Watchlist';
/** Days of history the row's small chart covers. */
export const SPARK_DAYS = 90;

export const TARGET_DIRECTIONS = ['below', 'above'] as const;
export type TargetDirection = (typeof TARGET_DIRECTIONS)[number];

/** One English price_history row of a printing (change-only, carried forward by readers). */
export type PriceRow = {
	snapshot_date: string;
	recorded_at: string | null;
	price_eur: number | null;
	price_eur_foil: number | null;
	price_usd: number | null;
	price_usd_foil: number | null;
};

export type Quote = { eur: number | null; usd: number | null };

/** The snapshot days the changes are measured against (UTC dates, YYYY-MM-DD). */
export type PriceRefs = {
	/** The newest price update. Null when the database has no price history. */
	latest: string | null;
	/** The price update before it: the "day" change. */
	previous: string | null;
	/** Seven and thirty calendar days before `latest`. */
	week: string | null;
	month: string | null;
};

export type Change = { amount: number; percent: number | null };

const DAY_MS = 86_400_000;

export function dayNumber(date: string): number {
	return Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

export function dateOf(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The reference days for a newest update `latest` and the one before it. */
export function priceRefs(latest: string | null, previous: string | null): PriceRefs {
	if (!latest) return { latest: null, previous: null, week: null, month: null };
	const day = dayNumber(latest);
	return { latest, previous, week: dateOf(day - 7), month: dateOf(day - 30) };
}

export function finishQuote(row: Pick<PriceRow, 'price_eur' | 'price_eur_foil' | 'price_usd' | 'price_usd_foil'> | null | undefined, foil: boolean): Quote {
	if (!row) return { eur: null, usd: null };
	return foil ? { eur: row.price_eur_foil ?? null, usd: row.price_usd_foil ?? null } : { eur: row.price_eur ?? null, usd: row.price_usd ?? null };
}

export function quoteValue(quote: Quote, market: Currency): number | null {
	return market === 'USD' ? quote.usd : quote.eur;
}

/**
 * The market a row is shown in: the chosen currency's market when it has a price,
 * else the other one (shown with its own symbol, never converted). Null without either.
 */
export function rowMarket(current: Quote, currency: Currency): Currency | null {
	if (quoteValue(current, currency) != null) return currency;
	const other: Currency = currency === 'USD' ? 'EUR' : 'USD';
	return quoteValue(current, other) != null ? other : null;
}

/** The last row on or before `date` (rows sorted by snapshot_date ascending). */
export function rowAsOf<T extends Pick<PriceRow, 'snapshot_date'>>(rows: T[], date: string | null): T | null {
	if (!date) return null;
	let found: T | null = null;
	for (const row of rows) {
		if (row.snapshot_date > date) break;
		found = row;
	}
	return found;
}

/**
 * The row in effect at a moment (an entry's added_at): the last one recorded at or
 * before it. The time of a row is its recorded_at, else the end of its snapshot day.
 */
export function rowAtTime<T extends Pick<PriceRow, 'snapshot_date' | 'recorded_at'>>(rows: T[], iso: string): T | null {
	const time = Date.parse(iso);
	if (!Number.isFinite(time)) return null;
	let found: T | null = null;
	for (const row of rows) {
		const at = Date.parse(row.recorded_at ?? `${row.snapshot_date}T23:59:59Z`);
		if (Number.isFinite(at) && at <= time) found = row;
	}
	return found;
}

/** now - then, with the percent against `then`. Null when either side is a gap. */
export function change(now: number | null, then: number | null): Change | null {
	if (now == null || then == null) return null;
	const amount = Math.round((now - then) * 100) / 100;
	return { amount, percent: then > 0 ? ((now - then) / then) * 100 : null };
}

/**
 * Whether a target price is reached: the price of the target's own market (never
 * converted) at or below a "below" target, at or above an "above" target. Null when
 * there is no target or that market has no price.
 */
export function targetReached(current: Quote, target: number | null, targetCurrency: Currency, direction: TargetDirection): boolean | null {
	if (target == null) return null;
	const price = quoteValue(current, targetCurrency);
	if (price == null) return null;
	return direction === 'above' ? price >= target : price <= target;
}

export type Spark = { path: string; low: number; high: number; rising: boolean | null };

/**
 * A small line of one market's price over the `days` days up to `latest`: one point
 * per change, the price before the window carried to its left edge and the last
 * price carried to its right edge. Null with fewer than two prices in the window.
 */
export function sparkline(rows: PriceRow[], foil: boolean, market: Currency, latest: string | null,
	{ days = SPARK_DAYS, width = 120, height = 32 }: { days?: number; width?: number; height?: number } = {}): Spark | null {
	if (!latest) return null;
	const end = dayNumber(latest), start = end - days;
	const points: Array<{ day: number; value: number }> = [];
	let before: number | null = null;
	for (const row of rows) {
		const value = quoteValue(finishQuote(row, foil), market);
		if (value == null) continue;
		const day = dayNumber(row.snapshot_date);
		if (day <= start) before = value;
		else if (day <= end) points.push({ day, value });
	}
	if (before != null) points.unshift({ day: start, value: before });
	if (!points.length) return null;
	if (points.at(-1)!.day < end) points.push({ day: end, value: points.at(-1)!.value });
	if (points.length < 2) return null;

	const values = points.map((p) => p.value);
	const low = Math.min(...values), high = Math.max(...values);
	const span = high - low;
	const round = (n: number) => Math.round(n * 10) / 10;
	const first = points[0].day, width_days = end - first || 1;
	const y = (v: number) => (span === 0 ? height / 2 : 2 + ((high - v) / span) * (height - 4));
	const path = points.map((p, i) => `${i ? 'L' : 'M'}${round(((p.day - first) / width_days) * width)},${round(y(p.value))}`).join(' ');
	const firstValue = points[0].value, lastValue = points.at(-1)!.value;
	return { path, low, high, rising: lastValue === firstValue ? null : lastValue > firstValue };
}

/** A watched printing as the server reads it, before prices are attached. */
export type WatchEntry = {
	id: number;
	list_id: number;
	card_id: string;
	foil: number;
	target_price: number | null;
	target_currency: string;
	target_direction: string;
	notes: string;
	added_at: string;
	name: string;
	set_code: string;
	set_name: string;
	collector_number: string;
	rarity: string | null;
	image_uri: string | null;
	local_image_path: string | null;
	mana_cost: string | null;
	price_eur: number | null;
	price_eur_foil: number | null;
	price_usd: number | null;
	price_usd_foil: number | null;
};

export type WatchRow = {
	id: number;
	listId: number;
	cardId: string;
	name: string;
	setCode: string;
	setName: string;
	collectorNumber: string;
	rarity: string | null;
	imageUri: string | null;
	localImagePath: string | null;
	manaCost: string | null;
	foil: boolean;
	notes: string;
	addedAt: string;
	/** The market this row's price and changes are in; null when neither market has a price. */
	market: Currency | null;
	price: number | null;
	/** True when the chosen market has no price and the other one is shown. */
	otherMarket: boolean;
	/** Both markets' current prices of the finish, for the total and the target. */
	current: Quote;
	day: Change | null;
	week: Change | null;
	month: Change | null;
	/** Since the entry was added, from the price in effect at that moment. */
	sinceAdded: Change | null;
	addedPrice: number | null;
	targetPrice: number | null;
	targetCurrency: Currency;
	targetDirection: TargetDirection;
	target: boolean | null;
	spark: Spark | null;
};

export function parseTargetDirection(value: unknown): TargetDirection {
	return value === 'above' ? 'above' : 'below';
}

/** Prices, changes and the small chart of one watched printing. `rows` are its English history, oldest first. */
export function watchRow(entry: WatchEntry, rows: PriceRow[], refs: PriceRefs, currency: Currency): WatchRow {
	const foil = entry.foil === 1;
	const current = finishQuote(entry, foil);
	const market = rowMarket(current, currency);
	const price = market ? quoteValue(current, market) : null;
	const past = (row: PriceRow | null) => (market && row ? quoteValue(finishQuote(row, foil), market) : null);
	const addedRow = rowAtTime(rows, entry.added_at);
	const addedPrice = past(addedRow);
	const targetCurrency: Currency = entry.target_currency === 'USD' ? 'USD' : 'EUR';
	const targetDirection = parseTargetDirection(entry.target_direction);
	return {
		id: entry.id,
		listId: entry.list_id,
		cardId: entry.card_id,
		name: entry.name,
		setCode: entry.set_code,
		setName: entry.set_name,
		collectorNumber: entry.collector_number,
		rarity: entry.rarity,
		imageUri: entry.image_uri,
		localImagePath: entry.local_image_path,
		manaCost: entry.mana_cost,
		foil,
		notes: entry.notes,
		addedAt: entry.added_at,
		market,
		price,
		otherMarket: market != null && market !== currency,
		current,
		day: change(price, past(rowAsOf(rows, refs.previous))),
		week: change(price, past(rowAsOf(rows, refs.week))),
		month: change(price, past(rowAsOf(rows, refs.month))),
		sinceAdded: change(price, addedPrice),
		addedPrice,
		targetPrice: entry.target_price,
		targetCurrency,
		targetDirection,
		target: targetReached(current, entry.target_price, targetCurrency, targetDirection),
		spark: market ? sparkline(rows, foil, market, refs.latest) : null
	};
}

export const WATCH_SORTS = ['added', 'name', 'price', 'day', 'week', 'month', 'since', 'target'] as const;
export type WatchSort = (typeof WATCH_SORTS)[number];

export function parseWatchSort(sort: string | null, dir: string | null): { sort: WatchSort; dir: 'asc' | 'desc' } {
	const valid = (WATCH_SORTS as readonly string[]).includes(sort ?? '') ? (sort as WatchSort) : 'added';
	const fallback = valid === 'name' ? 'asc' : 'desc';
	return { sort: valid, dir: dir === 'asc' || dir === 'desc' ? dir : fallback };
}

/**
 * Sorts rows; rows without a value for the key come last in both directions, ties by
 * name. Changes sort by percent, then amount. Prices in the other market are converted
 * for the order only, so a dollar row sorts among euro rows by its worth.
 */
export function sortWatchRows(rows: WatchRow[], sort: WatchSort, dir: 'asc' | 'desc', currency: Currency, usdToEur: number): WatchRow[] {
	const pct = (c: Change | null) => (c == null ? null : c.percent ?? (c.amount === 0 ? 0 : null));
	const key = (row: WatchRow): number | string | null => {
		switch (sort) {
			case 'name': return row.name.toLowerCase();
			case 'price': return row.price == null || !row.market ? null : convertMoney(row.price, row.market, currency, usdToEur);
			case 'day': return pct(row.day);
			case 'week': return pct(row.week);
			case 'month': return pct(row.month);
			case 'since': return pct(row.sinceAdded);
			case 'target': return row.target == null ? null : row.target ? 1 : 0;
			default: return row.addedAt;
		}
	};
	const sign = dir === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		const ka = key(a), kb = key(b);
		if (ka == null && kb == null) return a.name.localeCompare(b.name) || a.id - b.id;
		if (ka == null) return 1;
		if (kb == null) return -1;
		const order = ka < kb ? -1 : ka > kb ? 1 : 0;
		return order * sign || a.name.localeCompare(b.name) || a.id - b.id;
	});
}

export type WatchTotals = {
	/** One copy of every priced entry, in the display currency (other-market prices converted). */
	value: number;
	priced: number;
	unpriced: number;
	/** The sum of the day changes of the rows that have one, converted like the value. */
	dayMove: number;
	dayCompared: number;
	targetsReached: number;
};

export function watchTotals(rows: WatchRow[], currency: Currency, usdToEur: number): WatchTotals {
	const totals: WatchTotals = { value: 0, priced: 0, unpriced: 0, dayMove: 0, dayCompared: 0, targetsReached: 0 };
	for (const row of rows) {
		if (row.target) totals.targetsReached++;
		if (row.price == null || !row.market) {
			totals.unpriced++;
			continue;
		}
		totals.priced++;
		totals.value += convertMoney(row.price, row.market, currency, usdToEur);
		if (row.day) {
			totals.dayCompared++;
			totals.dayMove += convertMoney(row.day.amount, row.market, currency, usdToEur);
		}
	}
	totals.value = Math.round(totals.value * 100) / 100;
	totals.dayMove = Math.round(totals.dayMove * 100) / 100;
	return totals;
}

/** "+4.2%", "−1.0%", "0%"; null percent (from a zero price) as "". */
export function formatPercent(percent: number | null): string {
	if (percent == null || !Number.isFinite(percent)) return '';
	if (Math.abs(percent) < 0.05) return '0%';
	const sign = percent > 0 ? '+' : '−';
	return `${sign}${Math.abs(percent).toFixed(Math.abs(percent) >= 100 ? 0 : 1)}%`;
}

/** A list name: one line, trimmed, 1 to MAX_LIST_NAME characters. Null when invalid. */
export function cleanListName(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const name = value.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
	return name.length >= 1 && name.length <= MAX_LIST_NAME ? name : null;
}
