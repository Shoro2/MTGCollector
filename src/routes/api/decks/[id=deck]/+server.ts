import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { deleteDeck, ownDeckVisibility, updateDeck } from '$lib/server/decks';
import { deckAction, readBody, requirePublishCaptcha } from '$lib/server/deck-http';

/** Rename, change format, visibility, description, bracket or author name. Making the deck public needs the captcha. */
export async function PATCH({ request, locals, params, getClientAddress }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(async () => {
		const body = await readBody(request);
		await requirePublishCaptcha(body, ownDeckVisibility(sqlite, user.id, params.id), getClientAddress());
		return updateDeck(sqlite, user.id, params.id, body);
	});
}

export async function DELETE({ locals, params }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(() => deleteDeck(sqlite, user.id, params.id));
}
