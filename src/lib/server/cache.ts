import { sqlite } from './db.js';

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

export const tagsCache = createCache(
	() => sqlite.prepare('SELECT * FROM tags ORDER BY name').all() as Array<Record<string, unknown>>,
	30 * 1000 // 30 seconds
);
