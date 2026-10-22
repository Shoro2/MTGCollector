import { error, json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { cardPrintings } from '$lib/server/decks';

/** Every printing of a card, for the printing picker in the deck editor: `?card=<printing id>`. */
export async function GET({ url, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	return json({ printings: cardPrintings(sqlite, url.searchParams.get('card') ?? '') });
}
