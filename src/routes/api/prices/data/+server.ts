import { json, error } from '@sveltejs/kit';
import { priceDataCache } from '$lib/server/cache';

export async function GET({ locals }) {
	if (!locals.user) throw error(401, 'Unauthorized');
	const data = await priceDataCache.get(locals.user.id);
	return json(data, {
		headers: {
			'Cache-Control': 'private, max-age=300, stale-while-revalidate=600'
		}
	});
}
