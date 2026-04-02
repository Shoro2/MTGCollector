import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';

export async function POST({ request }) {
	const { name, color } = await request.json();
	sqlite.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name, color || '#3b82f6');
	return json({ success: true });
}

export async function PUT({ request }) {
	const { action, collectionCardId, tagId } = await request.json();

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

export async function DELETE({ request }) {
	const { id } = await request.json();
	sqlite.prepare('DELETE FROM collection_card_tags WHERE tag_id = ?').run(id);
	sqlite.prepare('DELETE FROM tags WHERE id = ?').run(id);
	return json({ success: true });
}
