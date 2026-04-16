import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { tagsCache } from '$lib/server/cache';

export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { name, color } = await request.json();
	const trimmed = typeof name === 'string' ? name.trim() : '';
	if (!trimmed) throw error(400, 'Tag name is required');
	if (trimmed.length > 64) throw error(400, 'Tag name too long');
	const safeColor = typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#3b82f6';
	try {
		sqlite
			.prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)')
			.run(locals.user.id, trimmed, safeColor);
	} catch (err) {
		const msg = (err as Error).message ?? '';
		if (msg.includes('UNIQUE')) throw error(409, 'You already have a tag with this name');
		throw err;
	}
	tagsCache.invalidate(locals.user.id);
	return json({ success: true });
}

export async function PUT({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { action, collectionCardId, tagId } = await request.json();

	// The user must own both the collection card and the tag — otherwise the
	// join row would cross-link data between accounts.
	const ownsCard = sqlite
		.prepare('SELECT id FROM collection_cards WHERE id = ? AND user_id = ?')
		.get(collectionCardId, locals.user.id);
	if (!ownsCard) throw error(403, 'Forbidden');
	const ownsTag = sqlite
		.prepare('SELECT id FROM tags WHERE id = ? AND user_id = ?')
		.get(tagId, locals.user.id);
	if (!ownsTag) throw error(403, 'Forbidden');

	if (action === 'add') {
		sqlite
			.prepare('INSERT OR IGNORE INTO collection_card_tags (collection_card_id, tag_id) VALUES (?, ?)')
			.run(collectionCardId, tagId);
	} else if (action === 'remove') {
		sqlite
			.prepare('DELETE FROM collection_card_tags WHERE collection_card_id = ? AND tag_id = ?')
			.run(collectionCardId, tagId);
	} else {
		throw error(400, 'Invalid action');
	}

	return json({ success: true });
}

export async function DELETE({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { id } = await request.json();
	const result = sqlite
		.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?')
		.run(id, locals.user.id);
	if (result.changes === 0) throw error(403, 'Forbidden');
	// collection_card_tags rows cascade via FK ON DELETE CASCADE on tag_id.
	tagsCache.invalidate(locals.user.id);
	return json({ success: true });
}
