import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';

export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { name, color } = await request.json();
	sqlite.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name, color || '#3b82f6');
	return json({ success: true });
}

export async function PUT({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { action, collectionCardId, tagId } = await request.json();

	// Verify user owns this collection card
	const owns = sqlite.prepare('SELECT id FROM collection_cards WHERE id = ? AND user_id = ?').get(collectionCardId, locals.user.id);
	if (!owns) throw error(403, 'Forbidden');

	if (action === 'add') {
		sqlite
			.prepare('INSERT OR IGNORE INTO collection_card_tags (collection_card_id, tag_id) VALUES (?, ?)')
			.run(collectionCardId, tagId);
	} else if (action === 'remove') {
		sqlite
			.prepare('DELETE FROM collection_card_tags WHERE collection_card_id = ? AND tag_id = ?')
			.run(collectionCardId, tagId);
	}

	return json({ success: true });
}

export async function DELETE({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { id } = await request.json();
	sqlite.prepare('DELETE FROM collection_card_tags WHERE tag_id = ?').run(id);
	sqlite.prepare('DELETE FROM tags WHERE id = ?').run(id);
	return json({ success: true });
}
