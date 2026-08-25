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

export interface BulkDataMeta {
	/** Scryfall's own timestamp for this bulk file. */
	updatedAt: string;
	/** URL to download. Gzipped JSONL on the current API. */
	downloadUri: string;
	/** Transfer size in bytes, or null when Scryfall doesn't report one. */
	downloadSize: number | null;
}

/**
 * Resolve the `default_cards` entry from Scryfall's bulk-data catalog.
 *
 * Scryfall replaced the plain-JSON `download_uri` (and `size`) with a gzipped
 * JSONL `jsonl_download_uri` (and `compressed_size`). Reading the old field
 * silently yielded `undefined` and every caller then failed with an opaque
 * "Failed to parse URL from undefined" — so the legacy names are still accepted
 * as a fallback, and a missing URI now raises an error that names the fields
 * the API actually returned.
 */
export async function fetchDefaultCardsBulkMeta(init: RequestInit = {}): Promise<BulkDataMeta> {
	const response = await scryfallFetch('https://api.scryfall.com/bulk-data', init);
	if (!response.ok) throw new Error(`Bulk data API failed: ${response.status}`);

	const body = await response.json();
	const entry = body?.data?.find((d: { type?: string }) => d.type === 'default_cards');
	if (!entry) throw new Error('Could not find default_cards bulk data');

	const downloadUri: unknown = entry.jsonl_download_uri ?? entry.download_uri;
	if (typeof downloadUri !== 'string' || downloadUri.length === 0) {
		throw new Error(
			`default_cards bulk entry has no usable download URI — Scryfall returned fields: ${Object.keys(entry).join(', ')}`
		);
	}

	return {
		updatedAt: entry.updated_at,
		downloadUri,
		downloadSize: entry.compressed_size ?? entry.size ?? null
	};
}
