import { json, error } from '@sveltejs/kit';
import { priceDataCache } from '$lib/server/cache';
import { createRateLimiter } from '$lib/server/rate-limit';

// The underlying fetcher runs three heavy aggregations (incl. window functions
// on price_history). The cache absorbs repeat hits within 10 min, but a cold
// cache followed by a burst (many tabs, reloads) still stampedes the DB, so
// guard the endpoint with a small per-user rate limit.
const limiter = createRateLimiter(10, 60 * 1000);

export async function GET({ locals }) {
	if (!locals.user) throw error(401, 'Unauthorized');
	if (!limiter.check(locals.user.id)) {
		throw error(429, 'Too many requests');
	}
	const data = await priceDataCache.get(locals.user.id);
	return json(data, {
		headers: {
			'Cache-Control': 'private, max-age=300, stale-while-revalidate=600'
		}
	});
}
