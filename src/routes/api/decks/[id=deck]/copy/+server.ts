import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { copyDeck } from '$lib/server/decks';
import { deckAction } from '$lib/server/deck-http';

/** A private copy in the signed-in account: of an own deck, or of anyone's shared deck. */
export async function POST({ locals, params }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(() => ({ id: copyDeck(sqlite, user.id, params.id) }));
}
