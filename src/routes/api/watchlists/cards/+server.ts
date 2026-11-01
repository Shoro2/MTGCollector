import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { addWatchEntry, removeWatchEntry, updateWatchEntry } from '$lib/server/watchlists';
import { readWatchBody, watchlistAction } from '$lib/server/watchlist-http';
import { parseCurrency } from '$lib/currency';

/**
 * Watch a printing: `{ cardId, foil?, listId?, targetPrice?, targetCurrency?, targetDirection?, notes? }`.
 * Without `listId` it goes on the first list, created as "Watchlist" when there is none.
 */
export async function POST({ request, locals }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return watchlistAction(async () => addWatchEntry(sqlite, user.id, await readWatchBody(request), parseCurrency(user.currency)));
}

/** Change one entry: `{ rowId, foil?, targetPrice?, targetCurrency?, targetDirection?, notes?, listId? }`. */
export async function PATCH({ request, locals }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return watchlistAction(async () => updateWatchEntry(sqlite, user.id, await readWatchBody(request)));
}

/** Stop watching: `{ rowId }`. */
export async function DELETE({ request, locals }) {
	const user = locals.user;
	if (!user) throw error(401, 'Not authenticated');
	return watchlistAction(async () => removeWatchEntry(sqlite, user.id, (await readWatchBody(request)).rowId));
}
