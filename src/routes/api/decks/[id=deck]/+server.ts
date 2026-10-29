import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { deleteDeck, updateDeck } from '$lib/server/decks';
import { deckAction, readBody } from '$lib/server/deck-http';

/** Rename, change format, visibility, description or bracket. */
export async function PATCH({ request, locals, params }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(async () => updateDeck(sqlite, user.id, params.id, await readBody(request)));
}

export async function DELETE({ locals, params }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(() => deleteDeck(sqlite, user.id, params.id));
}
