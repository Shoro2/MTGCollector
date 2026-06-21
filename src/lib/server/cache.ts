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
	// Tracks in-flight fetches so concurrent get(userId) calls that miss the
	// cache share a single fetcher run instead of stampeding — important for
	// the priceDataCache where the fetcher issues three heavy SQL aggregations.
	const inflight = new Map<string, Promise<T>>();
	let accessesSinceLastSweep = 0;
	// Every 64 accesses, evict entries older than 2×TTL to keep the map bounded
	// even if users log out and never return.
	const sweepInterval = 64;
	const evictAfterMs = ttlMs * 2;

	function maybeSweep() {
		if (++accessesSinceLastSweep < sweepInterval) return;
		accessesSinceLastSweep = 0;
		const cutoff = Date.now() - evictAfterMs;
		for (const [key, val] of entries) {
			if (val.at < cutoff) entries.delete(key);
		}
	}

	return {
		async get(userId: string): Promise<T> {
			maybeSweep();
			const entry = entries.get(userId);
			if (entry && Date.now() - entry.at <= ttlMs) {
				return entry.value;
			}
			const existing = inflight.get(userId);
			if (existing) return existing;

			const promise = (async () => {
				try {
					const value = await fetcher(userId);
					entries.set(userId, { value, at: Date.now() });
					return value;
				} finally {
					inflight.delete(userId);
				}
			})();
			inflight.set(userId, promise);
			return promise;
		},
		invalidate(userId: string) {
			entries.delete(userId);
		},
		invalidateAll() {
			entries.clear();
		}
	};
}

// Per-user tag list. Sync because the underlying query is a single indexed
// lookup — no reason to pay the async machinery cost.
export function createSyncUserCache<T>(fetcher: (userId: string) => T, ttlMs: number) {
	const entries = new Map<string, { value: T; at: number }>();
	let accessesSinceLastSweep = 0;
	const sweepInterval = 64;
	const evictAfterMs = ttlMs * 2;

	function maybeSweep() {
		if (++accessesSinceLastSweep < sweepInterval) return;
		accessesSinceLastSweep = 0;
		const cutoff = Date.now() - evictAfterMs;
		for (const [key, val] of entries) {
			if (val.at < cutoff) entries.delete(key);
		}
	}

	return {
		get(userId: string): T {
			maybeSweep();
			const entry = entries.get(userId);
			if (entry && Date.now() - entry.at <= ttlMs) return entry.value;
			const value = fetcher(userId);
			entries.set(userId, { value, at: Date.now() });
			return value;
		},
		invalidate(userId: string) { entries.delete(userId); },
		invalidateAll() { entries.clear(); }
	};
}

export const tagsCache = createSyncUserCache(
	(userId: string) =>
		sqlite
			.prepare('SELECT id, name, color FROM tags WHERE user_id = ? ORDER BY name')
			.all(userId) as Array<Record<string, unknown>>,
	30 * 1000 // 30 seconds
);

export const setsCache = createCache(
	() => sqlite.prepare('SELECT DISTINCT set_code, set_name FROM cards ORDER BY set_name ASC')
		.all() as Array<{ set_code: string; set_name: string }>,
	60 * 60 * 1000 // 1 hour
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
				CASE WHEN cc.foil = 1 THEN COALESCE(cpl.price_eur_foil, c.price_eur_foil) ELSE COALESCE(cpl.price_eur, c.price_eur) END as price,
				CASE WHEN cc.foil = 1 THEN COALESCE(cpl.price_usd_foil, c.price_usd_foil) ELSE COALESCE(cpl.price_usd, c.price_usd) END as price_usd,
				cc.id as collection_id, cc.quantity, cc.foil, cc.purchase_price, COALESCE(cc.language, 'en') as language,
				CASE WHEN cc.foil = 1 THEN (
					SELECT ph.price_eur_foil FROM price_history ph
					WHERE ph.card_id = cc.card_id
					  AND ph.language = COALESCE(cc.language, 'en')
					  AND ph.snapshot_date < DATE('now')
					ORDER BY ph.snapshot_date DESC, ph.recorded_at DESC
					LIMIT 1
				) ELSE (
					SELECT ph.price_eur FROM price_history ph
					WHERE ph.card_id = cc.card_id
					  AND ph.language = COALESCE(cc.language, 'en')
					  AND ph.snapshot_date < DATE('now')
					ORDER BY ph.snapshot_date DESC, ph.recorded_at DESC
					LIMIT 1
				) END as prev_price,
				CASE WHEN cc.foil = 1 THEN (
					SELECT ph.price_usd_foil FROM price_history ph
					WHERE ph.card_id = cc.card_id
					  AND ph.language = COALESCE(cc.language, 'en')
					  AND ph.snapshot_date < DATE('now')
					ORDER BY ph.snapshot_date DESC, ph.recorded_at DESC
					LIMIT 1
				) ELSE (
					SELECT ph.price_usd FROM price_history ph
					WHERE ph.card_id = cc.card_id
					  AND ph.language = COALESCE(cc.language, 'en')
					  AND ph.snapshot_date < DATE('now')
					ORDER BY ph.snapshot_date DESC, ph.recorded_at DESC
					LIMIT 1
				) END as prev_price_usd
			FROM collection_cards cc
			JOIN cards c ON cc.card_id = c.id
			LEFT JOIN card_prices_lang cpl ON cpl.card_id = cc.card_id AND cpl.language = COALESCE(cc.language, 'en')
			WHERE (CASE WHEN cc.foil = 1 THEN COALESCE(cpl.price_eur_foil, c.price_eur_foil) ELSE COALESCE(cpl.price_eur, c.price_eur) END IS NOT NULL
				OR CASE WHEN cc.foil = 1 THEN COALESCE(cpl.price_usd_foil, c.price_usd_foil) ELSE COALESCE(cpl.price_usd, c.price_usd) END IS NOT NULL)
				AND cc.user_id = ?`
		)
		.all(userId);

	// Collection stats — use USD * rate as fallback for EUR
	const stats = sqlite
		.prepare(
			`SELECT
				COALESCE(SUM(
					COALESCE(
						CASE WHEN cc.foil = 1 THEN COALESCE(cpl.price_eur_foil, c.price_eur_foil) ELSE COALESCE(cpl.price_eur, c.price_eur) END,
						CASE WHEN cc.foil = 1 THEN COALESCE(cpl.price_usd_foil, c.price_usd_foil) ELSE COALESCE(cpl.price_usd, c.price_usd) END * ?
					) * cc.quantity
				), 0) as totalValue,
				COALESCE(SUM(cc.purchase_price * cc.quantity), 0) as totalPurchaseValue,
				COUNT(*) as uniqueCards,
				COALESCE(SUM(cc.quantity), 0) as totalCards
			FROM collection_cards cc
			JOIN cards c ON cc.card_id = c.id
			LEFT JOIN card_prices_lang cpl ON cpl.card_id = cc.card_id AND cpl.language = cc.language
			WHERE cc.user_id = ?`
		)
		.get(usdToEur, userId) as { totalValue: number; totalPurchaseValue: number; uniqueCards: number; totalCards: number };

	// Cards missing purchase price
	const missingPriceCount = sqlite
		.prepare('SELECT COUNT(*) as count FROM collection_cards WHERE user_id = ? AND purchase_price IS NULL')
		.get(userId) as { count: number };

	// Profit history for the profit/loss chart. Restrict the series to this user's
	// collection cards first; scanning all price_history rows is what makes the
	// endpoint time out on large databases.
	const profitHistory = sqlite
		.prepare(
			`WITH user_cards AS (
				SELECT card_id, COALESCE(language, 'en') AS language, foil, quantity, purchase_price,
					DATE(COALESCE(added_at, '1970-01-01')) AS owned_from
				FROM collection_cards
				WHERE user_id = ? AND purchase_price IS NOT NULL
			),
			series_days AS (
				SELECT DISTINCT ph.snapshot_date AS day
				FROM price_history ph
				JOIN user_cards uc ON uc.card_id = ph.card_id AND uc.language = ph.language
				WHERE ph.snapshot_date IS NOT NULL
			),
			card_days AS (
				SELECT
					sd.day,
					uc.card_id,
					uc.language,
					uc.foil,
					uc.quantity,
					uc.purchase_price
				FROM series_days sd
				JOIN user_cards uc ON sd.day >= uc.owned_from
			),
			priced_days AS (
				SELECT
					cd.day,
					cd.quantity,
					cd.purchase_price,
					COALESCE(
						(SELECT CASE
							WHEN cd.foil = 1 THEN COALESCE(ph.price_eur_foil, ph.price_usd_foil * ?)
							ELSE COALESCE(ph.price_eur, ph.price_usd * ?)
						END
						FROM price_history ph
						WHERE ph.card_id = cd.card_id
						  AND ph.language = cd.language
						  AND ph.snapshot_date <= cd.day
						ORDER BY ph.snapshot_date DESC, ph.recorded_at DESC
						LIMIT 1),
						(SELECT CASE
							WHEN cd.foil = 1 THEN COALESCE(ph.price_eur_foil, ph.price_usd_foil * ?)
							ELSE COALESCE(ph.price_eur, ph.price_usd * ?)
						END
						FROM price_history ph
						WHERE ph.card_id = cd.card_id
						  AND ph.language = cd.language
						ORDER BY ph.snapshot_date ASC, ph.recorded_at ASC
						LIMIT 1)
					) AS value_per_card
				FROM card_days cd
			)
			SELECT
				pd.day AS recorded_at,
				SUM(COALESCE(pd.value_per_card, 0) * pd.quantity) AS total_value,
				SUM(pd.purchase_price * pd.quantity) AS total_purchase
			FROM priced_days pd
			GROUP BY pd.day
			ORDER BY pd.day ASC`
		)
		.all(userId, usdToEur, usdToEur, usdToEur, usdToEur);

	return {
		topCards,
		stats,
		missingPriceCount: missingPriceCount.count,
		profitHistory,
		usdToEur
	};
}, 10 * 60 * 1000); // 10 minutes
