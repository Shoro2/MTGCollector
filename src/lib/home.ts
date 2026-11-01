import { formatMoneyGrouped } from './currency';

// Homepage figures: price moves for visitors, the collection dashboard for signed-in
// users. Pure functions; the database reads are in $lib/server/home-data.ts.

/** A printing's latest English snapshot next to the snapshot before it. */
export type MoverRow = {
	oracle_id: string;
	name: string;
	set_code: string;
	now: number;
	usd: number | null;
	prev: number | null;
	prevUsd: number | null;
};

export type Mover = { oracleId: string; name: string; setCode: string; price: number; pct: number };

const percent = (now: number, prev: number) => Math.round(((now - prev) / prev) * 1000) / 10;

/**
 * Cardmarket's trend price collapses or spikes now and then on thinly traded
 * printings (see priceDivergence()). A move counts only when the EUR price agrees
 * with USD × rate within `maxRatio`, before and after, so such outliers never top
 * the list. Every card appears once, with its largest move.
 */
export function pickMovers(rows: MoverRow[], { rate, minPrice = 2, maxRatio = 2, limit = 5 }:
	{ rate: number; minPrice?: number; maxRatio?: number; limit?: number }) {
	const agrees = (eur: number, usd: number | null) =>
		usd != null && usd > 0 && Math.max(eur, usd * rate) / Math.min(eur, usd * rate) <= maxRatio;
	const best = new Map<string, Mover>();
	for (const r of rows) {
		if (r.prev == null || r.now < minPrice || r.prev < minPrice || r.now === r.prev) continue;
		if (!agrees(r.now, r.usd) || !agrees(r.prev, r.prevUsd)) continue;
		const move = { oracleId: r.oracle_id, name: r.name, setCode: r.set_code.toUpperCase(), price: r.now, pct: percent(r.now, r.prev) };
		const known = best.get(r.oracle_id);
		if (!known || Math.abs(move.pct) > Math.abs(known.pct)) best.set(r.oracle_id, move);
	}
	const moves = [...best.values()];
	return {
		up: moves.filter(m => m.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, limit),
		down: moves.filter(m => m.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, limit)
	};
}

/**
 * The fields of a getPriceData() top card the homepage reads: one copy's market price now
 * and before today, already in the user's display currency.
 */
export type Holding = {
	id: string;
	name: string;
	quantity: number;
	foil: number;
	language: string;
	value: number | null;
	prev_value: number | null;
};

export type CollectionMove = { id: string; name: string; foil: number; language: string; price: number; pct: number };

/** Largest moves of the user's own copies since the price before today (from 1 in the display currency). */
export function collectionMoves(cards: Holding[], { minPrice = 1, limit = 3 } = {}) {
	const seen = new Set<string>();
	const moves: CollectionMove[] = [];
	for (const c of cards) {
		const now = c.value;
		const prev = c.prev_value;
		const key = `${c.id}/${c.foil}/${c.language}`;
		if (now == null || prev == null || now < minPrice || prev < minPrice || now === prev || seen.has(key)) continue;
		seen.add(key);
		moves.push({ id: c.id, name: c.name, foil: c.foil, language: c.language, price: now, pct: percent(now, prev) });
	}
	return {
		up: moves.filter(m => m.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, limit),
		down: moves.filter(m => m.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, limit)
	};
}

type Stats = { totalValue: number; profitValue: number; profitCost: number; profitCopies: number; uniqueCards: number; totalCards: number };

/** The dashboard's figures, from the same getPriceData() result as /prices. */
export function dashboardSummary(data: { topCards: Holding[]; stats: Stats; proxyCopies: number }) {
	let change: number | null = null;
	for (const c of data.topCards) {
		if (c.value == null || c.prev_value == null) continue;
		change = (change ?? 0) + (c.value - c.prev_value) * c.quantity;
	}
	const { stats } = data;
	const profit = stats.profitCopies ? stats.profitValue - stats.profitCost : null;
	return {
		value: stats.totalValue,
		change: change == null ? null : Math.round(change * 100) / 100,
		profit,
		profitPct: profit != null && stats.profitCost > 0 ? Math.round((profit / stats.profitCost) * 1000) / 10 : null,
		cards: stats.totalCards,
		printings: stats.uniqueCards,
		proxies: data.proxyCopies
	};
}

type HistoryPoint = { recorded_at: string; total_value: number | null; total_purchase: number | null };
export type ChartPoint = { date: string; value: number; cost: number };

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
const dateOf = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

/**
 * SVG paths for value and purchase cost over the last `days` days. The last point
 * before the window is carried to its left edge; points without a value are gaps
 * in the data and are skipped. Null when fewer than two points remain.
 */
export function chartPaths(history: HistoryPoint[], { today, days = 90, width = 320, height = 120 }:
	{ today: string; days?: number; width?: number; height?: number }) {
	const start = dayNumber(today) - days;
	const points: ChartPoint[] = [];
	let before: ChartPoint | null = null;
	for (const p of history) {
		if (p.total_value == null || p.total_purchase == null) continue;
		const point = { date: p.recorded_at, value: p.total_value, cost: p.total_purchase };
		if (dayNumber(p.recorded_at) < start) before = point;
		else if (dayNumber(p.recorded_at) <= dayNumber(today)) points.push(point);
	}
	if (before && (!points.length || dayNumber(points[0].date) > start)) points.unshift({ ...before, date: dateOf(start) });
	if (points.length < 2) return null;

	const first = dayNumber(points[0].date), span = dayNumber(points.at(-1)!.date) - first || 1;
	const values = points.flatMap(p => [p.value, p.cost]);
	let low = Math.min(...values), high = Math.max(...values);
	const pad = (high - low) * 0.08 || Math.max(high * 0.08, 1);
	low -= pad; high += pad;
	const round = (n: number) => Math.round(n * 10) / 10;
	const path = (pick: (p: ChartPoint) => number) => points.map((p, i) =>
		`${i ? 'L' : 'M'}${round(((dayNumber(p.date) - first) / span) * width)},${round(((high - pick(p)) / (high - low)) * height)}`).join(' ');
	return { value: path(p => p.value), cost: path(p => p.cost), first: points[0], last: points.at(-1)! };
}

const monthDay = (date: string) =>
	new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

/** "Price moves on October 9", or the span when the price updates before it were missed. */
export function movesHeading(date: string, previousDate: string | null) {
	if (previousDate && dayNumber(date) - dayNumber(previousDate) > 2) return `Price moves from ${monthDay(previousDate)} to ${monthDay(date)}`;
	return `Price moves on ${monthDay(date)}`;
}

/** €1,248.30: grouped thousands for the visitor homepage (Cardmarket prices). */
export function euro(amount: number) {
	return formatMoneyGrouped(amount, 'EUR');
}

/** One stored day of the market value of every printing (market_value_daily). */
export type MarketDay = {
	snapshot_date: string;
	eur: number;
	eur_printings: number;
	eur_moved: number;
	usd: number;
	usd_printings: number;
	usd_moved: number;
};

/**
 * The homepage's market panel in one market: Cardmarket for euros, TCGplayer for US
 * dollars, never converted (each market's sum over the printings it prices). The
 * change is like-for-like: the price moves of printings priced on the latest update
 * day and the update before, so a set release adds printings without counting as a
 * rise. The chart covers the last `days` days; its range is given as labels because
 * a small move fills the whole height. Null without any stored day.
 */
export function marketSummary(history: MarketDay[], currency: 'EUR' | 'USD', { today, days = 90, width = 320, height = 80 }:
	{ today: string; days?: number; width?: number; height?: number }) {
	const pick = (d: MarketDay) => currency === 'USD'
		? { date: d.snapshot_date, value: d.usd, printings: d.usd_printings, moved: d.usd_moved }
		: { date: d.snapshot_date, value: d.eur, printings: d.eur_printings, moved: d.eur_moved };
	const all = history.map(pick).filter(p => p.printings > 0);
	if (!all.length) return null;
	const latest = all.at(-1)!;
	const previous = all.length > 1 ? all.at(-2)! : null;
	const change = previous ? latest.moved : null;
	const changePct = previous && previous.value > 0 ? Math.round((latest.moved / previous.value) * 10000) / 100 : null;

	const start = dayNumber(today) - days;
	const points = all.filter(p => dayNumber(p.date) >= start);
	let chart: { line: string; area: string; low: number; high: number; from: string; to: string } | null = null;
	if (points.length >= 2) {
		const first = dayNumber(points[0].date), span = dayNumber(points.at(-1)!.date) - first || 1;
		const low = Math.min(...points.map(p => p.value)), high = Math.max(...points.map(p => p.value));
		const pad = (high - low) * 0.1 || Math.max(high * 0.01, 1);
		const top = high + pad, bottom = low - pad;
		const round = (n: number) => Math.round(n * 10) / 10;
		const xy = points.map(p => `${round(((dayNumber(p.date) - first) / span) * width)},${round(((top - p.value) / (top - bottom)) * height)}`);
		const line = xy.map((c, i) => `${i ? 'L' : 'M'}${c}`).join(' ');
		chart = { line, area: `${line} L${width},${height} L0,${height} Z`, low, high, from: points[0].date, to: latest.date };
	}
	return {
		date: latest.date,
		value: latest.value,
		printings: latest.printings,
		change,
		changePct,
		previousDate: previous?.date ?? null,
		/** Printings with a price on the latest day that had none on the update before (net). */
		newPrintings: previous ? latest.printings - previous.printings : 0,
		chart
	};
}

/** "October 31" for the market panel's labels. */
export function shortDate(date: string) {
	return monthDay(date);
}
