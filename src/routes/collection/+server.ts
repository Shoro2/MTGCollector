import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';

export async function POST({ request }) {
	const { cardId, quantity, condition, foil, purchasePrice } = await request.json();

	sqlite
		.prepare(
			'INSERT INTO collection_cards (card_id, quantity, condition, foil, purchase_price, added_at) VALUES (?, ?, ?, ?, ?, ?)'
		)
		.run(cardId, quantity || 1, condition || 'near_mint', foil ? 1 : 0, purchasePrice ?? null, new Date().toISOString());

	return json({ success: true });
}

export async function PUT({ request }) {
	const { id, quantity, condition, foil, notes, purchasePrice } = await request.json();

	sqlite
		.prepare(
			'UPDATE collection_cards SET quantity = ?, condition = ?, foil = ?, notes = ?, purchase_price = ? WHERE id = ?'
		)
		.run(quantity, condition, foil ? 1 : 0, notes || null, purchasePrice ?? null, id);

	return json({ success: true });
}

export async function DELETE({ request }) {
	const { id } = await request.json();
	sqlite.prepare('DELETE FROM collection_card_tags WHERE collection_card_id = ?').run(id);
	sqlite.prepare('DELETE FROM collection_cards WHERE id = ?').run(id);
	return json({ success: true });
}

export async function PATCH() {
	const result = sqlite
		.prepare(
			`UPDATE collection_cards SET purchase_price = (
				SELECT CASE WHEN collection_cards.foil = 1 THEN c.price_eur_foil ELSE c.price_eur END
				FROM cards c WHERE c.id = collection_cards.card_id
			) WHERE purchase_price IS NULL`
		)
		.run();

	return json({ success: true, updated: result.changes });
}
