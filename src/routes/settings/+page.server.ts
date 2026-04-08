import { redirect, fail } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

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

	const visionRow = sqlite.prepare(
		'SELECT google_vision_api_key FROM users WHERE id = ?'
	).get(locals.user.id) as { google_vision_api_key: string | null } | undefined;

	const visionKey = visionRow?.google_vision_api_key ?? null;

	return {
		collectionCount: collectionCount.count,
		wishlistCount: wishlistCount.count,
		tagCount: tagCount.count,
		hasVisionApiKey: !!visionKey,
		visionKeyPreview: visionKey ? '…' + visionKey.slice(-4) : null
	};
};

export const actions: Actions = {
	setVisionKey: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, '/login');
		}

		const formData = await request.formData();
		const apiKey = (formData.get('apiKey') ?? '').toString().trim();

		if (!apiKey) {
			return fail(400, { setVisionKey: { error: 'Please enter an API key.' } });
		}
		if (apiKey.length > 200) {
			return fail(400, { setVisionKey: { error: 'API key is too long (max 200 characters).' } });
		}

		sqlite.prepare('UPDATE users SET google_vision_api_key = ? WHERE id = ?')
			.run(apiKey, locals.user.id);

		return { setVisionKey: { success: true } };
	},

	clearVisionKey: async ({ locals }) => {
		if (!locals.user) {
			throw redirect(302, '/login');
		}

		sqlite.prepare('UPDATE users SET google_vision_api_key = NULL WHERE id = ?')
			.run(locals.user.id);

		return { clearVisionKey: { success: true } };
	}
};
