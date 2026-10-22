import { error, json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { searchDeckCards } from '$lib/server/decks';

/** Card suggestions for the deck editor: `?q=&format=&commander=1&legal=1`. */
export async function GET({ url, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const q = (url.searchParams.get('q') ?? '').slice(0, 100);
	const cards = searchDeckCards(sqlite, q, {
		format: url.searchParams.get('format') ?? undefined,
		commander: url.searchParams.get('commander') === '1',
		legal: url.searchParams.get('legal') === '1'
	});
	return json({ cards }, { headers: { 'Cache-Control': 'private, max-age=60' } });
}
