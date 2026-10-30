import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { invalidateSessionCacheForUser } from '$lib/server/auth';
import { priceDataCache } from '$lib/server/cache';
import { isCurrency } from '$lib/currency';
import type { RequestHandler } from './$types';

/**
 * Account preferences from /settings. `{ currency: 'EUR' | 'USD' }` sets the display
 * currency every page prices in (src/lib/currency.ts). The cached session and the
 * cached portfolio figures carry the old currency, so both are dropped.
 */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'Invalid request.');
	const { currency } = body as { currency?: unknown };
	if (!isCurrency(currency)) throw error(400, 'Unknown currency.');

	sqlite.prepare('UPDATE users SET currency = ? WHERE id = ?').run(currency, locals.user.id);
	invalidateSessionCacheForUser(locals.user.id);
	priceDataCache.invalidate(locals.user.id);
	return json({ success: true, currency });
};
