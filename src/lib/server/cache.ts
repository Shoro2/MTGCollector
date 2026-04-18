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

	// Profit history. For each day that has any snapshot at all, and for every
	// collection card, carry forward the latest price_history row with
	// effective_date <= that day. The change-aware snapshot in price-updater.ts
	// only writes rows for cards whose price changed that day, so a naive
	// INNER JOIN per day would miss unchanged cards and produce a partial sum.
	const profitHistory = sqlite
		.prepare(
			`WITH series_days AS (
				SELECT DISTINCT DATE(
					recorded_at,
					CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10
					     THEN '-1 day' ELSE '0 days' END
				) AS day
				FROM price_history
			),
			user_cards AS (
				SELECT card_id, foil, quantity
				FROM collection_cards
				WHERE user_id = ? AND purchase_price IS NOT NULL
			),
			purchase_total AS (
				SELECT COALESCE(SUM(purchase_price * quantity), 0) AS total
				FROM collection_cards
				WHERE user_id = ? AND purchase_price IS NOT NULL
			),
			card_day_price AS (
				SELECT
					sd.day,
					uc.foil,
					uc.quantity,
					(SELECT ph.price_eur FROM price_history ph
						WHERE ph.card_id = uc.card_id
						  AND DATE(ph.recorded_at,
						      CASE WHEN CAST(strftime('%H', ph.recorded_at) AS INTEGER) < 10
						           THEN '-1 day' ELSE '0 days' END) <= sd.day
						ORDER BY ph.recorded_at DESC LIMIT 1) AS price_eur,
					(SELECT ph.price_eur_foil FROM price_history ph
						WHERE ph.card_id = uc.card_id
						  AND DATE(ph.recorded_at,
						      CASE WHEN CAST(strftime('%H', ph.recorded_at) AS INTEGER) < 10
						           THEN '-1 day' ELSE '0 days' END) <= sd.day
						ORDER BY ph.recorded_at DESC LIMIT 1) AS price_eur_foil,
					(SELECT ph.price_usd FROM price_history ph
						WHERE ph.card_id = uc.card_id
						  AND DATE(ph.recorded_at,
						      CASE WHEN CAST(strftime('%H', ph.recorded_at) AS INTEGER) < 10
						           THEN '-1 day' ELSE '0 days' END) <= sd.day
						ORDER BY ph.recorded_at DESC LIMIT 1) AS price_usd,
					(SELECT ph.price_usd_foil FROM price_history ph
						WHERE ph.card_id = uc.card_id
						  AND DATE(ph.recorded_at,
						      CASE WHEN CAST(strftime('%H', ph.recorded_at) AS INTEGER) < 10
						           THEN '-1 day' ELSE '0 days' END) <= sd.day
						ORDER BY ph.recorded_at DESC LIMIT 1) AS price_usd_foil
				FROM series_days sd
				CROSS JOIN user_cards uc
			)
			SELECT
				cdp.day AS recorded_at,
				SUM(COALESCE(
					CASE WHEN cdp.foil = 1 THEN cdp.price_eur_foil ELSE cdp.price_eur END,
					CASE WHEN cdp.foil = 1 THEN cdp.price_usd_foil ELSE cdp.price_usd END * ?
				) * cdp.quantity) AS total_value,
				pt.total AS total_purchase
			FROM card_day_price cdp
			CROSS JOIN purchase_total pt
			GROUP BY cdp.day, pt.total
			ORDER BY cdp.day ASC`
		)
		.all(userId, userId, usdToEur);

	return {
		topCards,
		stats,
		missingPriceCount: missingPriceCount.count,
		profitHistory,
		usdToEur
	};
}, 10 * 60 * 1000); // 10 minutes
