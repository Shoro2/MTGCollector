import { sqlite } from './db.js';
import { getUsdToEurRate } from './exchange-rate.js';
import { getPriceData } from './price-data.js';

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

// Mutations invalidate this server cache; browser responses must not outlive it.
export const priceDataCache = createUserCache(async (userId: string) => {
	const rate = await getUsdToEurRate();
	return getPriceData(sqlite, userId, rate);
}, 10 * 60 * 1000);