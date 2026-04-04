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
			.prepare(
				`WITH dp AS (
					SELECT price_eur, price_eur_foil,
						DATE(recorded_at, CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10 THEN '-1 day' ELSE '0 days' END) as effective_date,
						ROW_NUMBER() OVER (
							PARTITION BY DATE(recorded_at, CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10 THEN '-1 day' ELSE '0 days' END)
							ORDER BY recorded_at DESC
						) as rn
					FROM price_history WHERE card_id = ?
				)
				SELECT price_eur, price_eur_foil, effective_date as recorded_at
				FROM dp WHERE rn = 1
				ORDER BY effective_date ASC`
			)
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
	// First deduplicate price_history to one entry per card per effective date, then aggregate
	const profitHistory = sqlite
		.prepare(
			`WITH daily_prices AS (
				SELECT card_id, price_eur, price_eur_foil, price_usd, price_usd_foil, recorded_at,
					DATE(recorded_at, CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10 THEN '-1 day' ELSE '0 days' END) as effective_date,
					ROW_NUMBER() OVER (
						PARTITION BY card_id, DATE(recorded_at, CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10 THEN '-1 day' ELSE '0 days' END)
						ORDER BY recorded_at DESC
					) as rn
				FROM price_history
			)
			SELECT
				dp.effective_date as recorded_at,
				SUM(COALESCE(
					CASE WHEN cc.foil = 1 THEN dp.price_eur_foil ELSE dp.price_eur END,
					CASE WHEN cc.foil = 1 THEN dp.price_usd_foil ELSE dp.price_usd END * ?
				) * cc.quantity) as total_value,
				SUM(cc.purchase_price * cc.quantity) as total_purchase
			FROM daily_prices dp
			JOIN collection_cards cc ON dp.card_id = cc.card_id
			WHERE dp.rn = 1 AND cc.user_id = ? AND cc.purchase_price IS NOT NULL
			GROUP BY dp.effective_date
			ORDER BY dp.effective_date ASC`
		)
		.all(usdToEur, userId) as Array<{ recorded_at: string; total_value: number; total_purchase: number }>;

	const priceStatus = getPriceUpdateStatus();
	const hasNewData = await pricesNeedUpdate();

	return { profitHistory, topCards, cardPriceHistory, selectedCard, stats, missingPriceCount: missingPriceCount.count, priceStatus, hasNewData, usdToEur };
}
