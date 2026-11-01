import { sqlite } from '$lib/server/db';
import { marketValueHistory } from '$lib/server/market-value';
import type { Currency } from '$lib/currency';
import { marketPoints } from '$lib/home';
import { marketMonths, marketPeriod, marketSeo, parseMarketFilter, pointsInFilter } from '$lib/market-history';

export function load({ url, locals }) {
	const viewerCurrency: Currency = locals.user?.currency === 'USD' ? 'USD' : 'EUR';
	const filter = parseMarketFilter(url.searchParams, { currency: viewerCurrency, today: new Date().toISOString().slice(0, 10) });
	// One row per price-update day: a few hundred small rows, read directly.
	const all = marketPoints(marketValueHistory(sqlite, ''), filter.currency);
	const points = pointsInFilter(all, filter);
	return {
		viewerCurrency,
		filter,
		firstDate: all[0]?.date ?? null,
		lastDate: all.at(-1)?.date ?? null,
		points,
		period: marketPeriod(points),
		months: marketMonths(points),
		seo: marketSeo(url.searchParams)
	};
}
