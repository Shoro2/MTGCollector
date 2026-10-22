import { redirect } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { listDecks } from '$lib/server/decks';
import { getUsdToEurRate } from '$lib/server/exchange-rate';

/** The signed-in user's decks; search and sort happen in the page (URL parameters). */
export async function load({ locals, depends }) {
	if (!locals.user) throw redirect(302, '/login');
	depends('app:decks');
	return { decks: listDecks(sqlite, locals.user.id, await getUsdToEurRate()) };
}
