import { redirect } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(302, '/login');
	}

	const collectionCount = sqlite.prepare(
		'SELECT COUNT(*) as count FROM collection_cards WHERE user_id = ?'
	).get(locals.user.id) as { count: number };

	const wishlistCount = sqlite.prepare(
		'SELECT COUNT(*) as count FROM wishlist_cards WHERE user_id = ?'
	).get(locals.user.id) as { count: number };

	const tagCount = sqlite.prepare(
		`SELECT COUNT(DISTINCT t.id) as count FROM tags t
		 INNER JOIN collection_card_tags cct ON cct.tag_id = t.id
		 INNER JOIN collection_cards cc ON cc.id = cct.collection_card_id
		 WHERE cc.user_id = ?`
	).get(locals.user.id) as { count: number };

	return {
		collectionCount: collectionCount.count,
		wishlistCount: wishlistCount.count,
		tagCount: tagCount.count
	};
};
