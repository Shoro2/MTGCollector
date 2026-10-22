import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { importDeckList } from '$lib/server/decks';
import { deckAction, readBody } from '$lib/server/deck-http';

/** Import a pasted or uploaded list: `{ text, mode: 'add' | 'replace' }`. */
export async function POST({ request, locals, params }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return deckAction(async () => {
		const { text, mode } = await readBody(request);
		return importDeckList(sqlite, user.id, params.id, text, mode);
	});
}
