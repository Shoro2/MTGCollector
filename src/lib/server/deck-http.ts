import { json } from '@sveltejs/kit';
import { DeckError } from './decks';

/** Runs a deck action and answers `{ success: true, ...result }`, or the DeckError's message and status. */
export async function deckAction(run: () => object | void | Promise<object | void>) {
	try {
		return json({ success: true, ...((await run()) ?? {}) });
	} catch (err) {
		if (err instanceof DeckError) return json({ success: false, message: err.message }, { status: err.status });
		throw err;
	}
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DeckError('Send a JSON object.');
	return body as Record<string, unknown>;
}
