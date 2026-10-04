import { json, error } from '@sveltejs/kit';
import { priceDataCache } from '$lib/server/cache';
import { createRateLimiter } from '$lib/server/rate-limit';

// Share cached calculations, and bound bursts of reloads per user.
const limiter = createRateLimiter(10, 60 * 1000);

export async function GET({ locals }) {
	if (!locals.user) throw error(401, 'Unauthorized');
	if (!limiter.check(locals.user.id)) {
		throw error(429, 'Too many requests');
	}
	const data = await priceDataCache.get(locals.user.id);
	return json(data, {
		headers: {
			'Cache-Control': 'private, no-store'
		}
	});
}
