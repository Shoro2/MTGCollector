import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
 * Resolve a bulk-data entry (`default_cards` for the catalogue and prices,
 * `all_cards` for the printed names of every language) from Scryfall's catalog.
 *
 * Scryfall replaced the plain-JSON `download_uri` (and `size`) with a gzipped
 * JSONL `jsonl_download_uri` (and `compressed_size`). Reading the old field
 * silently yielded `undefined` and every caller then failed with an opaque
 * "Failed to parse URL from undefined" — so the legacy names are still accepted
 * as a fallback, and a missing URI now raises an error that names the fields
 * the API actually returned.
 */
export async function fetchBulkMeta(type: string, init: RequestInit = {}): Promise<BulkDataMeta> {
	const response = await scryfallFetch('https://api.scryfall.com/bulk-data', init);
	if (!response.ok) throw new Error(`Bulk data API failed: ${response.status}`);

	const body = await response.json();
	const entry = body?.data?.find((d: { type?: string }) => d.type === type);
	if (!entry) throw new Error(`Could not find ${type} bulk data`);

	const downloadUri: unknown = entry.jsonl_download_uri ?? entry.download_uri;
	if (typeof downloadUri !== 'string' || downloadUri.length === 0) {
		throw new Error(
			`${type} bulk entry has no usable download URI — Scryfall returned fields: ${Object.keys(entry).join(', ')}`
		);
	}

	return {
		updatedAt: entry.updated_at,
		downloadUri,
		downloadSize: entry.compressed_size ?? entry.size ?? null
	};
}

/** The catalogue's bulk file (English printings plus foreign-only ones). */
export function fetchDefaultCardsBulkMeta(init: RequestInit = {}): Promise<BulkDataMeta> {
	return fetchBulkMeta('default_cards', init);
}

/**
 * Download a bulk file with both a stall watchdog (no bytes for `stallMs`) and
 * a hard overall cap. Node's `fetch` can leave a body stream pending
 * indefinitely, and an unbounded wait never settles the promise, so a caller's
 * `finally` (the price updater's lock release) would never run. Resolves with
 * the number of bytes written.
 */
export async function downloadBulkFile(
	url: string,
	target: string,
	opts: { signal?: AbortSignal; stallMs: number; maxMs: number; abortMessage?: string }
): Promise<number> {
	const controller = new AbortController();
	const abort = (reason: Error) => controller.abort(reason);
	const onOuterAbort = () => abort(new Error(opts.abortMessage ?? 'Download aborted'));
	opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

	let stallTimer: NodeJS.Timeout | undefined;
	const armStall = () => {
		clearTimeout(stallTimer);
		stallTimer = setTimeout(() => abort(new Error(`Bulk download stalled — no data for ${opts.stallMs / 1000}s`)), opts.stallMs);
	};
	const hardTimer = setTimeout(() => abort(new Error(`Bulk download exceeded ${opts.maxMs / 60_000} min`)), opts.maxMs);

	try {
		armStall();
		const response = await scryfallFetch(url, { signal: controller.signal });
		if (!response.ok || !response.body) {
			throw new Error(`Download failed: ${response.status}`);
		}

		let bytes = 0;
		const watchdog = new Transform({
			transform(chunk, _enc, cb) {
				bytes += chunk.length;
				armStall();
				cb(null, chunk);
			}
		});

		mkdirSync(dirname(target), { recursive: true });
		await pipeline(
			Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
			watchdog,
			createWriteStream(target),
			{ signal: controller.signal }
		);
		return bytes;
	} finally {
		clearTimeout(stallTimer);
		clearTimeout(hardTimer);
		opts.signal?.removeEventListener('abort', onOuterAbort);
	}
}
