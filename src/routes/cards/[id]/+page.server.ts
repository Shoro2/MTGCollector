import { sqlite } from '$lib/server/db';
import { error } from '@sveltejs/kit';

export async function load({ params }) {
	const card = sqlite.prepare('SELECT * FROM cards WHERE id = ?').get(params.id) as Record<string, unknown> | undefined;
	if (!card) throw error(404, 'Card not found');

	const faces = sqlite
		.prepare('SELECT * FROM card_faces WHERE card_id = ? ORDER BY face_index')
		.all(params.id) as Array<Record<string, unknown>>;

	// Get reprints (same oracle_id, different set)
	let reprints: Array<Record<string, unknown>> = [];
	if (card.oracle_id) {
		reprints = sqlite
			.prepare('SELECT id, set_code, set_name, collector_number, price_eur, image_uri FROM cards WHERE oracle_id = ? AND id != ? ORDER BY released_at DESC')
			.all(card.oracle_id, params.id) as Array<Record<string, unknown>>;
	}

	// Get price history
	const priceHistory = sqlite
		.prepare('SELECT price_eur, price_eur_foil, recorded_at FROM price_history WHERE card_id = ? ORDER BY recorded_at ASC')
		.all(params.id) as Array<Record<string, unknown>>;

	// Check if in collection
	const inCollection = sqlite
		.prepare('SELECT id, quantity, condition, foil, notes FROM collection_cards WHERE card_id = ?')
		.all(params.id) as Array<Record<string, unknown>>;

	return { card, faces, reprints, priceHistory, inCollection };
}
