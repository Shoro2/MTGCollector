import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { addDeckCard, removeDeckCard, updateDeckCard } from '$lib/server/decks';
import { deckAction, readBody } from '$lib/server/deck-http';

/** Add a printing to a board: `{ cardId, board?, quantity?, foil? }`. */
export async function POST({ request, locals, params }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(async () => ({ card: addDeckCard(sqlite, user.id, params.id, await readBody(request)) }));
}

/** Change one entry: `{ rowId, quantity?, board?, cardId?, foil? }`. */
export async function PATCH({ request, locals, params }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(async () => {
		const { rowId, ...changes } = await readBody(request);
		updateDeckCard(sqlite, user.id, params.id, rowId, changes);
	});
}

export async function DELETE({ request, locals, params }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(async () => removeDeckCard(sqlite, user.id, params.id, (await readBody(request)).rowId));
}
