import { setsCache } from '$lib/server/cache';
import { sqlite } from '$lib/server/db';
import { collectionLocations } from '$lib/server/collection-actions';

export async function load({ locals }) {
	return { user: locals.user, sets: setsCache.get(), locations: locals.user ? collectionLocations(sqlite, locals.user.id) : [] };
}
