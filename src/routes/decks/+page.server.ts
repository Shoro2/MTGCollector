import { sqlite } from '$lib/server/db';
import { lastAuthorName, listDecks, publicDecks, publishBlocked, type PublicDeckSort } from '$lib/server/decks';
import { captchaSiteKey } from '$lib/server/captcha';
import { getUsdToEurRate } from '$lib/server/exchange-rate';
import { deckListSeo } from '$lib/deck-seo';

/**
 * Two lists: the signed-in user's decks (search and sort happen in the page) and everybody's
 * public decks (searched, filtered and paged here, also for visitors). `?view=public` picks
 * the public list; a visitor always gets it. The create dialog gets the author name the user
 * chose last, the captcha's site key (null when the captcha is off) and, when the user has
 * made three decks public within 24 hours, the limit's message (never for the admin).
 */
export async function load({ locals, url, depends }) {
	depends('app:decks');
	const rate = await getUsdToEurRate();
	const signedIn = !!locals.user;
	const create = locals.user ? {
		authorName: lastAuthorName(sqlite, locals.user.id),
		captchaSiteKey: captchaSiteKey(),
		publishBlocked: locals.user.isAdmin ? null : publishBlocked(sqlite, locals.user.id)
	} : null;
	if (!locals.user || url.searchParams.get('view') === 'public') {
		const params = url.searchParams;
		const list = publicDecks(sqlite, {
			q: params.get('q') ?? '',
			format: params.get('format') ?? '',
			sort: (params.get('sort') ?? 'updated') as PublicDeckSort,
			page: Number(params.get('page') ?? 1)
		}, rate);
		// The public list and its pages are landing pages for search engines; searches and filters are not.
		return { view: 'public' as const, signedIn, create, decks: [], public: list, seo: deckListSeo(params, list.page) };
	}
	return { view: 'mine' as const, signedIn, create, decks: listDecks(sqlite, locals.user.id, rate), public: null, seo: null };
}
