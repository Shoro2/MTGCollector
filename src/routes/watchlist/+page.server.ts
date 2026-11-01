import { error, redirect } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { userWatchlists, watchlistView, WatchlistError } from '$lib/server/watchlists';
import { getUsdToEurRate } from '$lib/server/exchange-rate';
import { parseWatchSort, sortWatchRows, watchTotals } from '$lib/watchlist';

export async function load({ url, locals, depends }) {
	if (!locals.user) throw redirect(302, '/login');
	depends('app:watchlist');
	const userId = locals.user.id;
	const currency = locals.user.currency;
	const lists = userWatchlists(sqlite, userId);
	const { sort, dir } = parseWatchSort(url.searchParams.get('sort'), url.searchParams.get('dir'));
	const usdToEur = await getUsdToEurRate();

	if (!lists.length) return { lists, view: null, sort, dir, usdToEur };

	const asked = url.searchParams.get('list');
	const listId = asked ? Number(asked) : lists[0].id;
	if (!lists.some((l) => l.id === listId)) throw error(404, 'List not found');
	try {
		const view = watchlistView(sqlite, userId, listId, currency);
		return {
			lists,
			view: { ...view, rows: sortWatchRows(view.rows, sort, dir, currency, usdToEur), totals: watchTotals(view.rows, currency, usdToEur) },
			sort,
			dir,
			usdToEur
		};
	} catch (err) {
		if (err instanceof WatchlistError) throw error(err.status, err.message);
		throw err;
	}
}
