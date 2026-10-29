import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { assertCanPublish, createDeck } from '$lib/server/decks';
import { deckAction, readBody, requirePublishCaptcha } from '$lib/server/deck-http';

/**
 * Create a deck: name, format, visibility, optional commander and pasted list. A public deck
 * needs the captcha and counts towards the limit of three public decks per 24 hours (not for the admin).
 */
export async function POST({ request, locals, getClientAddress }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(async () => {
		const body = await readBody(request);
		const publishLimit = !user.isAdmin;
		await requirePublishCaptcha(body, null, getClientAddress(), () => publishLimit && assertCanPublish(sqlite, user.id));
		return createDeck(sqlite, user.id, body, { publishLimit });
	});
}
