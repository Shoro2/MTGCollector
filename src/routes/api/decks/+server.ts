import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { createDeck } from '$lib/server/decks';
import { deckAction, readBody } from '$lib/server/deck-http';

/** Create a deck: name, format, visibility, optional commander and pasted list. */
export async function POST({ request, locals }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(async () => createDeck(sqlite, user.id, await readBody(request)));
}
