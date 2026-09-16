import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { priceDataCache } from '$lib/server/cache';

// One-time repair for collections whose added_at was reset by a sync import.
// A sync import deletes and re-inserts every row with added_at = now, and the
// /prices value/profit chart only plots each card from its added_at onward, so
// a re-sync collapses the whole history to "today" even though price_history is
// fully intact.
//
// This backdates each of the caller's collection cards to the earliest
// price_history snapshot available for that printing + language. It only ever
// moves the date EARLIER: cards whose added_at already predates their first
// snapshot, and cards with no price history at all, are left untouched. Scoped
// to the caller's own collection and idempotent, so it is safe to run twice.
export async function POST({ locals }) {
	if (!locals.user) throw error(401, 'Unauthorized');
	const userId = locals.user.id;

	const result = sqlite
		.prepare(
			`UPDATE collection_cards
			 SET added_at = (
				 SELECT MIN(ph.snapshot_date) FROM price_history ph
				 WHERE ph.card_id = collection_cards.card_id
				   AND ph.language = COALESCE(collection_cards.language, 'en')
				   AND ph.snapshot_date IS NOT NULL
			 ) || 'T00:00:00.000Z'
			 WHERE collection_cards.user_id = ?
			   AND EXISTS (
				 SELECT 1 FROM price_history ph
				 WHERE ph.card_id = collection_cards.card_id
				   AND ph.language = COALESCE(collection_cards.language, 'en')
				   AND ph.snapshot_date IS NOT NULL
				   AND ph.snapshot_date < DATE(collection_cards.added_at)
			 )`
		)
		.run(userId);

	priceDataCache.invalidate(userId);

	return json({ success: true, updated: result.changes });
}
