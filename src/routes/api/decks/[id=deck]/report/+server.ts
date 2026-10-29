import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { reportDeck } from '$lib/server/decks';
import { deckAction } from '$lib/server/deck-http';
import { createRateLimiter } from '$lib/server/rate-limit';

// Twenty reports an hour per account is far beyond honest use.
const limiter = createRateLimiter(20, 60 * 60 * 1000);

/** Report someone else's shared deck: `{ reason: 'spam' | 'offensive' | 'other' }`, once per deck. */
export async function POST({ locals, params, request }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	if (!limiter.check(user.id)) throw error(429, 'Too many reports. Try again later.');
	const body = await request.json().catch(() => ({}));
	return deckAction(() => reportDeck(sqlite, user.id, params.id, body?.reason));
}
