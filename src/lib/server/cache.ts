import { sqlite } from './db.js';
import { getUsdToEurRate } from './exchange-rate.js';

export function createCache<T>(fetcher: () => T, ttlMs: number) {
	let cached: { value: T; at: number } | null = null;
	return {
		get(): T {
			if (!cached || Date.now() - cached.at > ttlMs) {
				cached = { value: fetcher(), at: Date.now() };
			}
			return cached.value;
		},
		invalidate() {
			cached = null;
		}
	};
}

export function createUserCache<T>(fetcher: (userId: string) => Promise<T>, ttlMs: number) {
	const entries = new Map<string, { value: T; at: number }>();
	return {
		async get(userId: string): Promise<T> {
			const entry = entries.get(userId);
			if (entry && Date.now() - entry.at <= ttlMs) {
				return entry.value;
			}
			const value = await fetcher(userId);
			entries.set(userId, { value, at: Date.now() });
			return value;
		},
		invalidate(userId: string) {
			entries.delete(userId);
		},
		invalidateAll() {
			entries.clear();
		}
	};
}

export const tagsCache = createCache(
	() => sqlite.prepare('SELECT * FROM tags ORDER BY name').all() as Array<Record<string, unknown>>,
	30 * 1000 // 30 seconds
);

interface PriceData {
	topCards: unknown[];
	stats: { totalValue: number; totalPurchaseValue: number; uniqueCards: number; totalCards: number };
	missingPriceCount: number;
	profitHistory: unknown[];
	usdToEur: number;
}

export const priceDataCache = createUserCache<PriceData>(async (userId: string) => {
	const usdToEur = await getUsdToEurRate();

	// Most valuable cards in collection, with previous day's price for daily change
	const topCards = sqlite
		.prepare(
			`SELECT c.id, c.name, c.set_name, c.image_uri, c.local_image_path,
				CASE WHEN cc.foil = 1 THEN c.price_eur_foil ELSE c.price_eur END as price,
				CASE WHEN cc.foil = 1 THEN c.price_usd_foil ELSE c.price_usd END as price_usd,
				cc.id as collection_id, cc.quantity, cc.foil, cc.purchase_price,
				CASE WHEN cc.foil = 1 THEN prev.price_eur_foil ELSE prev.price_eur END as prev_price,
				CASE WHEN cc.foil = 1 THEN prev.price_usd_foil ELSE prev.price_usd END as prev_price_usd
			FROM collection_cards cc
			JOIN cards c ON cc.card_id = c.id
			LEFT JOIN (
				SELECT card_id, price_eur, price_eur_foil, price_usd, price_usd_foil
				FROM (
					SELECT card_id, price_eur, price_eur_foil, price_usd, price_usd_foil,
						ROW_NUMBER() OVER (PARTITION BY card_id ORDER BY recorded_at DESC) as rn
					FROM price_history
					WHERE DATE(recorded_at) < DATE('now')
				) WHERE rn = 1
			) prev ON prev.card_id = c.id
			WHERE (CASE WHEN cc.foil = 1 THEN c.price_eur_foil ELSE c.price_eur END IS NOT NULL
				OR CASE WHEN cc.foil = 1 THEN c.price_usd_foil ELSE c.price_usd END IS NOT NULL)
				AND cc.user_id = ?`
		)
		.all(userId);

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

	// Profit history
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
			),
			purchase_total AS (
				SELECT COALESCE(SUM(cc2.purchase_price * cc2.quantity), 0) as total
				FROM collection_cards cc2
				WHERE cc2.user_id = ? AND cc2.purchase_price IS NOT NULL
			)
			SELECT
				dp.effective_date as recorded_at,
				SUM(COALESCE(
					CASE WHEN cc.foil = 1 THEN dp.price_eur_foil ELSE dp.price_eur END,
					CASE WHEN cc.foil = 1 THEN dp.price_usd_foil ELSE dp.price_usd END * ?
				) * cc.quantity) as total_value,
				pt.total as total_purchase
			FROM daily_prices dp
			JOIN collection_cards cc ON dp.card_id = cc.card_id
			CROSS JOIN purchase_total pt
			WHERE dp.rn = 1 AND cc.user_id = ? AND cc.purchase_price IS NOT NULL
			GROUP BY dp.effective_date
			ORDER BY dp.effective_date ASC`
		)
		.all(userId, usdToEur, userId);

	return {
		topCards,
		stats,
		missingPriceCount: missingPriceCount.count,
		profitHistory,
		usdToEur
	};
}, 10 * 60 * 1000); // 10 minutes
