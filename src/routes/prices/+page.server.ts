import { sqlite } from '$lib/server/db';
import { getPriceUpdateStatus } from '$lib/server/price-updater';

export async function load({ url }) {
	const cardId = url.searchParams.get('card');

	// Collection value over time
	const valueHistory = sqlite
		.prepare(
			`SELECT
				ph.recorded_at,
				SUM(CASE WHEN cc.foil = 1 THEN ph.price_eur_foil ELSE ph.price_eur END * cc.quantity) as total_value
			FROM price_history ph
			JOIN collection_cards cc ON ph.card_id = cc.card_id
			GROUP BY ph.recorded_at
			ORDER BY ph.recorded_at ASC`
		)
		.all() as Array<{ recorded_at: string; total_value: number }>;

	// Most valuable cards in collection
	const topCards = sqlite
		.prepare(
			`SELECT c.id, c.name, c.set_name, c.image_uri, c.local_image_path,
				CASE WHEN cc.foil = 1 THEN c.price_eur_foil ELSE c.price_eur END as price,
				cc.quantity, cc.foil, cc.purchase_price
			FROM collection_cards cc
			JOIN cards c ON cc.card_id = c.id
			WHERE price IS NOT NULL
			ORDER BY price * cc.quantity DESC
			LIMIT 20`
		)
		.all() as Array<Record<string, unknown>>;

	// Single card price history
	let cardPriceHistory: Array<Record<string, unknown>> = [];
	let selectedCard: Record<string, unknown> | null = null;
	if (cardId) {
		selectedCard = sqlite.prepare('SELECT id, name, set_name FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | null;
		cardPriceHistory = sqlite
			.prepare('SELECT price_eur, price_eur_foil, recorded_at FROM price_history WHERE card_id = ? ORDER BY recorded_at ASC')
			.all(cardId) as Array<Record<string, unknown>>;
	}

	// Collection stats
	const stats = sqlite
		.prepare(
			`SELECT
				COALESCE(SUM(CASE WHEN cc.foil = 1 THEN c.price_eur_foil ELSE c.price_eur END * cc.quantity), 0) as totalValue,
				COALESCE(SUM(cc.purchase_price * cc.quantity), 0) as totalPurchaseValue,
				COUNT(*) as uniqueCards,
				COALESCE(SUM(cc.quantity), 0) as totalCards
			FROM collection_cards cc
			JOIN cards c ON cc.card_id = c.id`
		)
		.get() as { totalValue: number; totalPurchaseValue: number; uniqueCards: number; totalCards: number };

	const priceStatus = getPriceUpdateStatus();

	return { valueHistory, topCards, cardPriceHistory, selectedCard, stats, priceStatus };
}
