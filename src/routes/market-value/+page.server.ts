import { sqlite } from '$lib/server/db';
import { marketSetsCache } from '$lib/server/cache';
import { marketValueHistory, marketValueSetHistory } from '$lib/server/market-value';
import type { Currency } from '$lib/currency';
import { marketPoints } from '$lib/home';
import { marketMonths, marketPeriod, marketSeo, parseMarketFilter, pointsInFilter } from '$lib/market-history';

export function load({ url, locals }) {
	const viewerCurrency: Currency = locals.user?.currency === 'USD' ? 'USD' : 'EUR';
	const sets = marketSetsCache.get();
	const filter = parseMarketFilter(url.searchParams, {
		currency: viewerCurrency,
		today: new Date().toISOString().slice(0, 10),
		sets: new Set(sets.map((s) => s.code))
	});
	// One row per price-update day (a few hundred small rows), or one set's rows with
	// the days between carried forward; read directly.
	const days = filter.set ? marketValueSetHistory(sqlite, filter.set, '') : marketValueHistory(sqlite, '');
	const all = marketPoints(days, filter.currency);
	const points = pointsInFilter(all, filter);
	return {
		viewerCurrency,
		filter,
		sets,
		setName: filter.set ? sets.find((s) => s.code === filter.set)?.name ?? null : null,
		firstDate: all[0]?.date ?? null,
		lastDate: all.at(-1)?.date ?? null,
		points,
		period: marketPeriod(points),
		months: marketMonths(points),
		seo: marketSeo(url.searchParams)
	};
}
