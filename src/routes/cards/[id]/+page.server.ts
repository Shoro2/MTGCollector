import { sqlite } from '$lib/server/db';
import { error } from '@sveltejs/kit';

const CARD_COLUMNS = `id, oracle_id, name, mana_cost, cmc, type_line, oracle_text,
	colors, color_identity, keywords, set_code, set_name, collector_number, rarity,
	power, toughness, loyalty, image_uri, local_image_path, layout, legalities,
	released_at, scryfall_uri, price_eur, price_eur_foil, price_usd, price_usd_foil`;

const CARD_FACE_COLUMNS = `id, card_id, face_index, name, mana_cost, type_line,
	oracle_text, image_uri, power, toughness`;

export async function load({ params, locals, depends }) {
	// Named dependency so collection/wishlist mutations invalidate this load
	// without re-running every load in the tree.
	depends('app:card-detail');
	const card = sqlite.prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = ?`).get(params.id) as Record<string, unknown> | undefined;
	if (!card) throw error(404, 'Card not found');

	const faces = sqlite
		.prepare(`SELECT ${CARD_FACE_COLUMNS} FROM card_faces WHERE card_id = ? ORDER BY face_index`)
		.all(params.id) as Array<Record<string, unknown>>;

	// Get reprints (same oracle_id, different set)
	let reprints: Array<Record<string, unknown>> = [];
	if (card.oracle_id) {
		reprints = sqlite
			.prepare('SELECT id, set_code, set_name, collector_number, price_eur, price_usd, image_uri FROM cards WHERE oracle_id = ? AND id != ? ORDER BY released_at DESC LIMIT 30')
			.all(card.oracle_id, params.id) as Array<Record<string, unknown>>;
	}

	// Get price history (deduplicated to one per day by effective date)
	const priceHistory = sqlite
		.prepare(
			`WITH dp AS (
				SELECT price_eur, price_eur_foil, price_usd, price_usd_foil,
					DATE(recorded_at, CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10 THEN '-1 day' ELSE '0 days' END) as effective_date,
					ROW_NUMBER() OVER (
						PARTITION BY DATE(recorded_at, CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10 THEN '-1 day' ELSE '0 days' END)
						ORDER BY recorded_at DESC
					) as rn
				FROM price_history WHERE card_id = ?
			)
			SELECT price_eur, price_eur_foil, price_usd, price_usd_foil, effective_date as recorded_at
			FROM dp WHERE rn = 1
			ORDER BY effective_date ASC`
		)
		.all(params.id) as Array<Record<string, unknown>>;

	// Check if in collection (user-specific)
	const userId = locals?.user?.id;
	const inCollection = userId
		? sqlite.prepare('SELECT id, quantity, condition, foil, notes FROM collection_cards WHERE card_id = ? AND user_id = ?').all(params.id, userId) as Array<Record<string, unknown>>
		: [];

	// Check if on wishlist (user-specific)
	const onWishlist = userId
		? sqlite.prepare('SELECT id FROM wishlist_cards WHERE card_id = ? AND user_id = ?').get(params.id, userId) as { id: number } | undefined
		: undefined;

	return { card, faces, reprints, priceHistory, inCollection, onWishlist: onWishlist ?? null };
}
