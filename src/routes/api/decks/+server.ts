import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { createDeck } from '$lib/server/decks';
import { deckAction, readBody, requirePublishCaptcha } from '$lib/server/deck-http';

/** Create a deck: name, format, visibility, optional commander and pasted list. A public deck needs the captcha. */
export async function POST({ request, locals, getClientAddress }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(async () => {
		const body = await readBody(request);
		await requirePublishCaptcha(body, null, getClientAddress());
		return createDeck(sqlite, user.id, body);
	});
}
