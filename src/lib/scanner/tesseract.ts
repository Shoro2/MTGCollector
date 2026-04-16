/**
 * Tesseract.js worker pool for parallel OCR. A singleton pool is created
 * on first use and reused across scans.
 *
 * recognizeBatch distributes image URLs across the pool via a shared
 * work-stealing counter so workers that finish early pick up the next
 * pending image rather than sitting idle.
 */

// Loose typing — the upstream types don't match what's actually shipped
// through the CDN ESM bundle.
export type WordBox = {
	text: string;
	bbox: { x0: number; y0: number; x1: number; y1: number };
};
type TesseractWorker = {
	recognize: (url: string) => Promise<{ data: { text: string; words?: WordBox[] } }>;
	setParameters: (params: Record<string, unknown>) => Promise<unknown>;
};

export type DetailedOcrResult = { text: string; words: WordBox[] };

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js';

let pool: TesseractWorker[] = [];
let poolPromise: Promise<TesseractWorker[]> | null = null;

export async function getTesseractPool(): Promise<TesseractWorker[]> {
	if (pool.length > 0) return pool;
	if (poolPromise) return poolPromise;

	poolPromise = (async () => {
		const Tesseract = await import(/* @vite-ignore */ TESSERACT_URL);
		const createWorker = Tesseract.createWorker || Tesseract.default?.createWorker;
		if (!createWorker) throw new Error('Failed to load Tesseract.js');

		// Cap at 4 — more than that rarely helps and eats memory on mobile.
		const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
		const poolSize = Math.min(4, Math.max(1, hw >= 4 ? 4 : hw));
		pool = await Promise.all(
			Array.from({ length: poolSize }, () => createWorker('eng') as Promise<TesseractWorker>)
		);
		return pool;
	})();
	return poolPromise;
}

/** Broadcast tessedit_* parameters to every worker in the pool. */
export async function setPoolParameters(p: TesseractWorker[], params: Record<string, unknown>): Promise<void> {
	await Promise.all(p.map((w) => w.setParameters(params)));
}

/**
 * Recognize every `url` across the worker pool in parallel.
 * `onProgress` (if provided) is called after each image with (done, total).
 * Returns raw text per input index; failed images get ''.
 */
export async function recognizeBatch(
	p: TesseractWorker[],
	urls: string[],
	onProgress?: (done: number, total: number) => void
): Promise<string[]> {
	const total = urls.length;
	const results: string[] = new Array(total).fill('');
	let done = 0;
	let next = 0;

	async function runWorker(worker: TesseractWorker) {
		while (true) {
			const i = next++;
			if (i >= total) return;
			try {
				const r = await worker.recognize(urls[i]);
				results[i] = (r.data.text ?? '').toString();
			} catch {
				results[i] = '';
			}
			done++;
			onProgress?.(done, total);
		}
	}

	await Promise.all(p.map(runWorker));
	return results;
}

/**
 * Single-image recognize that also returns word-level bounding boxes.
 * Used by single-card mode for pixel-based foil detection; batching
 * doesn't buy anything for one image so we just use pool[0].
 */
export async function recognizeDetailed(
	p: TesseractWorker[],
	url: string
): Promise<DetailedOcrResult> {
	if (p.length === 0) return { text: '', words: [] };
	try {
		const r = await p[0].recognize(url);
		return {
			text: (r.data.text ?? '').toString(),
			words: Array.isArray(r.data.words) ? r.data.words : []
		};
	} catch {
		return { text: '', words: [] };
	}
}
