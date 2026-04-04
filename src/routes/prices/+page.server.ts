import { sqlite } from '$lib/server/db';
import { getPriceUpdateStatus, pricesNeedUpdate } from '$lib/server/price-updater';
import { getUsdToEurRate } from '$lib/server/exchange-rate';
import { redirect } from '@sveltejs/kit';

export async function load({ url, locals }) {
	if (!locals.user) throw redirect(302, '/login');
	const userId = locals.user.id;
	const usdToEur = await getUsdToEurRate();

	const cardId = url.searchParams.get('card');

	// Most valuable cards in collection
	const topCards = sqlite
		.prepare(
			`SELECT c.id, c.name, c.set_name, c.image_uri, c.local_image_path,
				CASE WHEN cc.foil = 1 THEN c.price_eur_foil ELSE c.price_eur END as price,
				CASE WHEN cc.foil = 1 THEN c.price_usd_foil ELSE c.price_usd END as price_usd,
				cc.id as collection_id, cc.quantity, cc.foil, cc.purchase_price
			FROM collection_cards cc
			JOIN cards c ON cc.card_id = c.id
			WHERE (price IS NOT NULL OR price_usd IS NOT NULL) AND cc.user_id = ?
			ORDER BY COALESCE(price, price_usd * ?) * cc.quantity DESC
			LIMIT 20`
		)
		.all(userId, usdToEur) as Array<Record<string, unknown>>;

	// Single card price history
	let cardPriceHistory: Array<Record<string, unknown>> = [];
	let selectedCard: Record<string, unknown> | null = null;
	if (cardId) {
		selectedCard = sqlite.prepare('SELECT id, name, set_name FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | null;
		cardPriceHistory = sqlite
			.prepare(`SELECT price_eur, price_eur_foil, recorded_at FROM price_history WHERE card_id = ? AND recorded_at IN (SELECT MAX(recorded_at) FROM price_history GROUP BY DATE(recorded_at, CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10 THEN '-1 day' ELSE '0 days' END)) ORDER BY recorded_at ASC`)
			.all(cardId) as Array<Record<string, unknown>>;
	}

	// Collection stats — use USD * rate as fallback for EUR
	const stats = sqlite
		.prepare(
			`SELECT
				COALESCE(SUM(
					COALESCE(
						CASE WHEN cc.foil = 1 THEN c.price_eur_foil ELSE c.price_eur END,
						CASE WHEN cc.foil = 1 THEN c.price_usd_foil ELSE c.price_usd END * ?
					) * cc.quantity
				), 0) as totalValue,
				COALESCE(SUM(cc.purchase_price * cc.quantity), 0) as totalPurchaseValue,
				COUNT(*) as uniqueCards,
				COALESCE(SUM(cc.quantity), 0) as totalCards
			FROM collection_cards cc
			JOIN cards c ON cc.card_id = c.id
			WHERE cc.user_id = ?`
		)
		.get(usdToEur, userId) as { totalValue: number; totalPurchaseValue: number; uniqueCards: number; totalCards: number };

	// Cards missing purchase price
	const missingPriceCount = sqlite
		.prepare('SELECT COUNT(*) as count FROM collection_cards WHERE user_id = ? AND purchase_price IS NULL')
		.get(userId) as { count: number };

	// Purchase value over time (sum of purchase_prices stays constant, value changes)
	const profitHistory = sqlite
		.prepare(
			`SELECT
				ph.recorded_at,
				SUM(COALESCE(
					CASE WHEN cc.foil = 1 THEN ph.price_eur_foil ELSE ph.price_eur END,
					CASE WHEN cc.foil = 1 THEN ph.price_usd_foil ELSE ph.price_usd END * ?
				) * cc.quantity) as total_value,
				SUM(cc.purchase_price * cc.quantity) as total_purchase
			FROM price_history ph
			JOIN collection_cards cc ON ph.card_id = cc.card_id
			JOIN cards c ON cc.card_id = c.id
			WHERE cc.user_id = ? AND cc.purchase_price IS NOT NULL
			AND ph.recorded_at IN (SELECT MAX(recorded_at) FROM price_history GROUP BY DATE(recorded_at, CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10 THEN '-1 day' ELSE '0 days' END))
			GROUP BY ph.recorded_at
			ORDER BY ph.recorded_at ASC`
		)
		.all(usdToEur, userId) as Array<{ recorded_at: string; total_value: number; total_purchase: number }>;

	const priceStatus = getPriceUpdateStatus();
	const hasNewData = await pricesNeedUpdate();

	return { profitHistory, topCards, cardPriceHistory, selectedCard, stats, missingPriceCount: missingPriceCount.count, priceStatus, hasNewData, usdToEur };
}
