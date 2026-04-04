// Use globalThis.fetch to avoid SvelteKit's SSR fetch warning
const nativeFetch = globalThis.fetch;

let cachedRate: { rate: number; fetchedAt: number } | null = null;
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

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
			return rate;
		}
	} catch {
		// fallback
	}

	// Fallback rate if API fails
	return cachedRate?.rate ?? 0.92;
}
