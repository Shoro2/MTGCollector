// Fixed-window in-process rate limiter. Not shared across Node processes, so
// limits apply per-instance — fine for the single-process deployment model
// this app targets. Bounded by a periodic sweep so stale keys don't leak.

type Bucket = { hits: number[] };

export interface RateLimiter {
	/** Returns true if the caller may proceed, false if they are over the limit. */
	check(key: string): boolean;
}

export function createRateLimiter(max: number, windowMs: number): RateLimiter {
	const buckets = new Map<string, Bucket>();
	let accessesSinceSweep = 0;
	const sweepInterval = 256;

	function sweep(now: number) {
		for (const [key, bucket] of buckets) {
			const fresh = bucket.hits.filter((t) => now - t < windowMs);
			if (fresh.length === 0) buckets.delete(key);
			else bucket.hits = fresh;
		}
	}

	return {
		check(key: string): boolean {
			const now = Date.now();
			if (++accessesSinceSweep >= sweepInterval) {
				accessesSinceSweep = 0;
				sweep(now);
			}

			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = { hits: [] };
				buckets.set(key, bucket);
			}
			bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
			if (bucket.hits.length >= max) return false;
			bucket.hits.push(now);
			return true;
		}
	};
}
