import { json } from '@sveltejs/kit';
import { WatchlistError } from './watchlists';

/** Runs a watchlist action and answers `{ success: true, ...result }`, or the WatchlistError's message and status. */
export async function watchlistAction(run: () => object | void | Promise<object | void>) {
	try {
		return json({ success: true, ...((await run()) ?? {}) });
	} catch (err) {
		if (err instanceof WatchlistError) return json({ success: false, message: err.message }, { status: err.status });
		throw err;
	}
}

export async function readWatchBody(request: Request): Promise<Record<string, unknown>> {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WatchlistError('Send a JSON object.');
	return body as Record<string, unknown>;
}
