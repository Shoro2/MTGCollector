const SCRYFALL_USER_AGENT = 'MTGCollector/0.0.1 (+https://mtg-collector.com)';
const SCRYFALL_ACCEPT = 'application/json;q=0.9,*/*;q=0.8';

function withScryfallHeaders(headers?: HeadersInit): Headers {
	const merged = new Headers(headers);
	if (!merged.has('User-agent')) merged.set('User-Agent', SCRYFALL_USER_AGENT);
	if (!merged.has('Accept')) merged.set('Accept', SCRYFALL_ACCEPT);
	return merged;
}

export function scryfallFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
	return globalThis.fetch(input, {
		...init,
		headers: withScryfallHeaders(init.headers)
	});
}
