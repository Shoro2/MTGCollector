/**
 * Card images served from this host (owner decision 2026-10-30).
 *
 * The browser asks `/card-image/<size>/<side>/<id>.jpg`; the route looks up the
 * printing's current Scryfall URL in the catalogue and calls `get()`. A cached
 * file is served from `data/card-images/`; on a miss the image is fetched from
 * Scryfall once and stored. Only printings of the catalogue are fetched (the
 * route checks the id), so the cache is bounded by the catalogue and a visitor
 * cannot use the host as a general proxy.
 *
 * Kept free of db.ts: the directory and fetch are injected, so the unit test
 * runs on a temporary directory and a fake Scryfall.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scryfallImageAtSize, type CardImageSize, type ScryfallImage } from '../card-image';

export type CardImageResult =
	| { ok: true; body: Buffer; cached: boolean }
	| { ok: false; status: 404 | 502 | 503 };

export interface CardImageCacheOptions {
	/** Root directory of the cache, e.g. `data/card-images`. */
	dir: string;
	fetch?: typeof globalThis.fetch;
	userAgent?: string;
	/** Upper bound of one image; Scryfall's "large" JPEGs are 100–250 KB. */
	maxBytes?: number;
	timeoutMs?: number;
	/** Upstream fetches running at the same time. */
	concurrency?: number;
	/** Upstream fetches per minute (all visitors together); further misses answer 503. */
	perMinute?: number;
	/** How long a failed fetch is not retried (Scryfall answered 403/5xx or nothing). */
	failureBackoffMs?: number;
	now?: () => number;
}

export interface CardImageCache {
	get(image: ScryfallImage, size: CardImageSize): Promise<CardImageResult>;
	/** The file a cached image lives in (exported for the test and the docs). */
	pathFor(image: ScryfallImage, size: CardImageSize): string;
}

const MISSING_BACKOFF_MS = 24 * 60 * 60 * 1000;

export function createCardImageCache(options: CardImageCacheOptions): CardImageCache {
	const {
		dir,
		fetch: fetchImpl = globalThis.fetch,
		userAgent = 'MTGCollector/1.0 (+https://mtg-collector.com)',
		maxBytes = 2 * 1024 * 1024,
		timeoutMs = 15_000,
		concurrency = 6,
		perMinute = 600,
		failureBackoffMs = 10 * 60 * 1000,
		now = Date.now
	} = options;

	const inflight = new Map<string, Promise<CardImageResult>>();
	const failures = new Map<string, { until: number; status: 404 | 502 }>();
	let running = 0;
	const waiting: Array<() => void> = [];
	let windowStart = 0;
	let windowCount = 0;

	const folder = (image: ScryfallImage, size: CardImageSize) =>
		join(dir, size, image.side, image.id[0], image.id[1]);
	// The version is part of the name: a re-scanned image is a new file, the old one is removed.
	const fileName = (image: ScryfallImage) => `${image.id}.${image.version ?? '0'}.jpg`;
	const pathFor = (image: ScryfallImage, size: CardImageSize) => join(folder(image, size), fileName(image));

	async function slot(): Promise<() => void> {
		if (running >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
		running++;
		return () => {
			running--;
			waiting.shift()?.();
		};
	}

	function withinBudget(): boolean {
		const t = now();
		if (t - windowStart >= 60_000) {
			windowStart = t;
			windowCount = 0;
		}
		if (windowCount >= perMinute) return false;
		windowCount++;
		return true;
	}

	async function download(image: ScryfallImage, size: CardImageSize, key: string): Promise<CardImageResult> {
		const failed = failures.get(key);
		if (failed && failed.until > now()) return { ok: false, status: failed.status };
		if (!withinBudget()) return { ok: false, status: 503 };

		const release = await slot();
		try {
			let response: Response;
			try {
				response = await fetchImpl(scryfallImageAtSize(image, size), {
					headers: { 'User-Agent': userAgent, Accept: 'image/jpeg,image/*;q=0.9' },
					signal: AbortSignal.timeout(timeoutMs)
				});
			} catch {
				failures.set(key, { until: now() + failureBackoffMs, status: 502 });
				return { ok: false, status: 502 };
			}
			const type = response.headers.get('content-type') ?? '';
			if (!response.ok || !type.startsWith('image/')) {
				const status = response.status === 404 ? 404 : 502;
				failures.set(key, { until: now() + (status === 404 ? MISSING_BACKOFF_MS : failureBackoffMs), status });
				return { ok: false, status };
			}
			const body = Buffer.from(await response.arrayBuffer());
			if (body.length === 0 || body.length > maxBytes) {
				failures.set(key, { until: now() + failureBackoffMs, status: 502 });
				return { ok: false, status: 502 };
			}
			failures.delete(key);

			const target = folder(image, size);
			await mkdir(target, { recursive: true });
			const file = join(target, fileName(image));
			// Write and rename, so a reader never sees half a file.
			const temp = `${file}.${process.pid}.${now()}.tmp`;
			await writeFile(temp, body);
			await rename(temp, file);
			const stale = (await readdir(target)).filter(
				(name) => name.startsWith(`${image.id}.`) && name !== fileName(image) && name.endsWith('.jpg')
			);
			await Promise.all(stale.map((name) => unlink(join(target, name)).catch(() => {})));
			return { ok: true, body, cached: false };
		} finally {
			release();
		}
	}

	return {
		pathFor,
		async get(image, size) {
			try {
				return { ok: true, body: await readFile(pathFor(image, size)), cached: true };
			} catch {
				// Not cached yet.
			}
			const key = `${size}/${image.side}/${image.id}/${image.version ?? ''}`;
			let pending = inflight.get(key);
			if (!pending) {
				pending = download(image, size, key).finally(() => inflight.delete(key));
				inflight.set(key, pending);
			}
			return pending;
		}
	};
}
