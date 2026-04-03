import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';

export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { cardId, priority, notes } = await request.json();

	// Check if already on wishlist
	const existing = sqlite.prepare('SELECT id FROM wishlist_cards WHERE user_id = ? AND card_id = ?').get(locals.user.id, cardId);
	if (existing) {
		return json({ success: false, message: 'Already on wishlist' }, { status: 409 });
	}

	sqlite.prepare(
		'INSERT INTO wishlist_cards (user_id, card_id, priority, notes, added_at) VALUES (?, ?, ?, ?, ?)'
	).run(locals.user.id, cardId, priority || 0, notes || null, new Date().toISOString());

	return json({ success: true });
}

export async function PUT({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { id, priority, notes } = await request.json();

	sqlite.prepare(
		'UPDATE wishlist_cards SET priority = ?, notes = ? WHERE id = ? AND user_id = ?'
	).run(priority ?? 0, notes || null, id, locals.user.id);

	return json({ success: true });
}

export async function DELETE({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { id } = await request.json();

	sqlite.prepare('DELETE FROM wishlist_cards WHERE id = ? AND user_id = ?').run(id, locals.user.id);
	return json({ success: true });
}
