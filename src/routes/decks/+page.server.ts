import { sqlite } from '$lib/server/db';
import { listDecks, publicDecks, type PublicDeckSort } from '$lib/server/decks';
import { getUsdToEurRate } from '$lib/server/exchange-rate';

/**
 * Two lists: the signed-in user's decks (search and sort happen in the page) and everybody's
 * public decks (searched, filtered and paged here, also for visitors). `?view=public` picks
 * the public list; a visitor always gets it.
 */
export async function load({ locals, url, depends }) {
	depends('app:decks');
	const rate = await getUsdToEurRate();
	const signedIn = !!locals.user;
	if (!locals.user || url.searchParams.get('view') === 'public') {
		const params = url.searchParams;
		return {
			view: 'public' as const,
			signedIn,
			decks: [],
			public: publicDecks(sqlite, {
				q: params.get('q') ?? '',
				format: params.get('format') ?? '',
				sort: (params.get('sort') ?? 'updated') as PublicDeckSort,
				page: Number(params.get('page') ?? 1)
			}, rate)
		};
	}
	return { view: 'mine' as const, signedIn, decks: listDecks(sqlite, locals.user.id, rate), public: null };
}
