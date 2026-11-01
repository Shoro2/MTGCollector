import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { createWatchlist, deleteWatchlist, renameWatchlist } from '$lib/server/watchlists';
import { readWatchBody, watchlistAction } from '$lib/server/watchlist-http';

/** Create a list: `{ name }`; answers its id. */
export async function POST({ request, locals }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return watchlistAction(async () => ({ id: createWatchlist(sqlite, user.id, (await readWatchBody(request)).name) }));
}

/** Rename a list: `{ id, name }`. */
export async function PATCH({ request, locals }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return watchlistAction(async () => {
		const body = await readWatchBody(request);
		renameWatchlist(sqlite, user.id, body.id, body.name);
	});
}

/** Delete a list and its entries: `{ id }`. */
export async function DELETE({ request, locals }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return watchlistAction(async () => deleteWatchlist(sqlite, user.id, (await readWatchBody(request)).id));
}
