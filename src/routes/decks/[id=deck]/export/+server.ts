import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { deckCards, readableDeck } from '$lib/server/decks';
import { deckListText } from '$lib/deck-text';
import { slugifyCardName } from '$lib/card-slug';

/**
 * The deck as text, for everyone who may read the deck: `?style=printings` (default,
 * "1 Name (SET) 123" for Moxfield, Archidekt and Arena) or `?style=names`; `download=1`
 * answers with a file.
 */
export async function GET({ params, url, locals }) {
	const deck = readableDeck(sqlite, params.id, locals.user?.id ?? null);
	if (!deck) throw error(404, 'Deck not found');
	const style = url.searchParams.get('style') === 'names' ? 'names' : 'printings';
	const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' };
	if (url.searchParams.get('download') === '1') {
		headers['Content-Disposition'] = `attachment; filename="${slugifyCardName(deck.name) || 'deck'}.txt"`;
	}
	return new Response(deckListText(deckCards(sqlite, deck.id), style), { headers });
}
