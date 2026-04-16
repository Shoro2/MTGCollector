// Use globalThis.fetch to avoid SvelteKit's SSR fetch warning
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const nativeFetch = globalThis.fetch;

const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours
const FALLBACK_RATE = 0.92;

const dataDir = join(process.cwd(), 'data');
const cachePath = join(dataDir, 'exchange-rate.json');

type CachedRate = { rate: number; fetchedAt: number };

let cachedRate: CachedRate | null = loadFromDisk();

function loadFromDisk(): CachedRate | null {
	try {
		if (!existsSync(cachePath)) return null;
		const parsed = JSON.parse(readFileSync(cachePath, 'utf-8'));
		if (typeof parsed?.rate === 'number' && typeof parsed?.fetchedAt === 'number') {
			return parsed;
		}
	} catch { /* corrupt file — refetch */ }
	return null;
}

function saveToDisk(value: CachedRate) {
	try {
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(cachePath, JSON.stringify(value), 'utf-8');
	} catch { /* disk errors shouldn't break price rendering */ }
}

export async function getUsdToEurRate(): Promise<number> {
	if (cachedRate && Date.now() - cachedRate.fetchedAt < CACHE_DURATION) {
		return cachedRate.rate;
	}

	try {
		const res = await nativeFetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR');
		const data = await res.json();
		const rate = data.rates?.EUR;
		if (typeof rate === 'number') {
			cachedRate = { rate, fetchedAt: Date.now() };
			saveToDisk(cachedRate);
			return rate;
		}
	} catch {
		// fall through to cached/fallback
	}

	return cachedRate?.rate ?? FALLBACK_RATE;
}
