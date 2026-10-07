import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { bulkEditCollection, moveCollectionCopies } from '$lib/server/collection-actions';
import { priceDataCache } from '$lib/server/cache';
import { ensureForeignPricesSequential } from '$lib/server/foreign-prices';

export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	try {
		const body = await request.json();
		if (body.action === 'move') {
			moveCollectionCopies(sqlite, locals.user.id, body.id, body.quantity, body.location);
		} else if (body.action === 'edit') {
			const pairs = bulkEditCollection(sqlite, locals.user.id, body.ids, body.changes);
			ensureForeignPricesSequential(pairs).catch(() => {});
		} else throw new Error('Invalid action.');
		priceDataCache.invalidate(locals.user.id);
		return json({ success: true });
	} catch (cause) {
		return json({ success: false, message: cause instanceof Error ? cause.message : 'Could not update collection.' }, { status: 400 });
	}
}
