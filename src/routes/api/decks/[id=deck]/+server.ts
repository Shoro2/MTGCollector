import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { assertCanPublish, deleteDeck, ownDeckVisibility, updateDeck } from '$lib/server/decks';
import { deckAction, readBody, requirePublishCaptcha } from '$lib/server/deck-http';

/**
 * Rename, change format, visibility, description, bracket or author name. Making the deck
 * public needs the captcha and counts towards the limit of three per 24 hours (not for the admin).
 */
export async function PATCH({ request, locals, params, getClientAddress }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(async () => {
		const body = await readBody(request);
		const publishLimit = !user.isAdmin;
		await requirePublishCaptcha(body, ownDeckVisibility(sqlite, user.id, params.id), getClientAddress(), () => publishLimit && assertCanPublish(sqlite, user.id));
		return updateDeck(sqlite, user.id, params.id, body, { publishLimit });
	});
}

export async function DELETE({ locals, params }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(() => deleteDeck(sqlite, user.id, params.id));
}
