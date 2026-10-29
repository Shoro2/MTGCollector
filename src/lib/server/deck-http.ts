import { json } from '@sveltejs/kit';
import { DeckError, deckMeta } from './decks';
import { checkCaptcha } from './captcha';
import { publishes, type Visibility } from '$lib/deck';

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

/**
 * Validates the deck fields first (a typo should not spend the captcha), then, when the
 * write makes the deck public (see publishes()), the publish limit (`checkLimit`, so a
 * refused deck does not spend the token either) and the Turnstile token in `body.captcha`.
 * `current` is the deck's visibility before the write, null for a new deck. The write
 * itself checks the limit again inside its transaction (createDeck, updateDeck).
 */
export async function requirePublishCaptcha(body: Record<string, unknown>, current: Visibility | null, ip: string | null, checkLimit: () => void = () => {}) {
	deckMeta(body, true);
	if (!publishes(current, body.visibility)) return;
	checkLimit();
	if (!(await checkCaptcha(body.captcha, ip, 'publish-deck'))) {
		throw new DeckError('Confirm the check "Verify you are human" before you make the deck public.');
	}
}
