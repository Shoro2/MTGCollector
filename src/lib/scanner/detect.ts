/**
 * Lightweight card-rectangle detection for the live preview overlay.
 *
 * The OpenCV work itself lives in `quick-rects.ts`; this module decides
 * *where* it runs. `createQuickDetector()` starts the detection Web Worker
 * (`detect-worker.ts`, bundled to `static/scanner/detect-worker.js`), which
 * loads its own OpenCV.js copy and analyses frames off the main thread, so
 * the video preview stays smooth while a frame is processed. When workers
 * are unavailable, the worker script fails to load or OpenCV fails inside
 * it, the detector falls back to the main thread transparently.
 *
 * Frames are handed over as an RGBA buffer (transferred, not copied): the
 * caller draws the video into a small analysis canvas exactly as before and
 * the detector reads it back once. Every result also carries the frame's
 * quality (sharpness/glare over the detected cards), computed on the same
 * pixels the rectangles were found in.
 */

import { loadOpenCV } from './opencv.js';
import { openCvUrl } from './assets.js';
import { detectOnPixels, type DetectQuickOptions, type QuickDetection, type QuickRect } from './quick-rects.js';

export type { DetectQuickOptions, QuickDetection, QuickRect } from './quick-rects.js';

export type QuickDetectorOptions = {
	/** Set false to stay on the main thread (tests, diagnostics). Default true. */
	preferWorker?: boolean;
	/** URL of the bundled worker script. Default `/scanner/detect-worker.js`. */
	workerUrl?: string;
	log?: (msg: string) => void;
};

export type QuickDetector = {
	/** Where detection runs. */
	readonly mode: 'worker' | 'main';
	/** True while a frame is being analysed; callers should skip frames rather than queue them. */
	readonly busy: boolean;
	/** Analyse the canvas (read-only). Coordinates come back in canvas pixels times `opts.coordScale`. */
	detect(canvas: HTMLCanvasElement, opts?: DetectQuickOptions): Promise<QuickDetection>;
	dispose(): void;
};

/**
 * Bundled worker script (see scripts/build-detect-worker.mjs); a static file so it stays a classic
 * worker in dev and prod. The URL is fixed, so callers append the app version as a query
 * (`workerUrl`): behind a CDN the file is served with `max-age=14400`, and a phone ran the old
 * detector for hours after a deploy while the page itself was new.
 */
export const DETECT_WORKER_URL = '/scanner/detect-worker.js';
const WORKER_INIT_TIMEOUT_MS = 30_000;
const WORKER_DETECT_TIMEOUT_MS = 5_000;

const EMPTY_QUALITY = { sharpness: 0, glare: 0, score: 0 };

function readPixels(canvas: HTMLCanvasElement): ImageData | null {
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
	return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Main-thread detector: OpenCV on the page's own `window.cv`. */
function createMainThreadDetector(): QuickDetector {
	let busy = false;
	return {
		mode: 'main',
		get busy() {
			return busy;
		},
		async detect(canvas, opts = {}) {
			if (busy) return { rects: [], quality: EMPTY_QUALITY };
			busy = true;
			try {
				await loadOpenCV();
				const cv = (window as unknown as { cv: any }).cv;
				const pixels = readPixels(canvas);
				if (!pixels) return { rects: [], quality: EMPTY_QUALITY };
				return detectOnPixels(cv, pixels.data, pixels.width, pixels.height, opts);
			} finally {
				busy = false;
			}
		},
		dispose() {
			/* nothing to release */
		}
	};
}

type WorkerResult = { type: 'result'; id: number; rects: QuickRect[]; quality: QuickDetection['quality'] | null; ms: number; error?: string };

/** Start the worker and wait until its OpenCV copy is ready; rejects when anything fails. */
function startWorker(url: string, log?: (msg: string) => void): Promise<Worker> {
	return new Promise((resolve, reject) => {
		if (typeof Worker === 'undefined') {
			reject(new Error('Web Workers unavailable'));
			return;
		}
		let worker: Worker;
		try {
			worker = new Worker(url);
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => finish(() => {
			worker.terminate();
			reject(new Error('detection worker did not become ready in time'));
		}), WORKER_INIT_TIMEOUT_MS);
		worker.onmessage = (e: MessageEvent) => {
			const msg = e.data;
			if (msg?.type === 'ready') {
				// A bundle without a build stamp predates the stamp: it came out of a cache.
				log?.(`worker build ${typeof msg.build === 'string' ? msg.build : 'unknown (a bundle from before 2026-09-17, probably cached)'}`);
				finish(() => resolve(worker));
			} else if (msg?.type === 'error') {
				finish(() => {
					worker.terminate();
					reject(new Error(msg.message || 'detection worker failed to initialise'));
				});
			} else if (msg?.type === 'log') {
				log?.(String(msg.message));
			}
		};
		worker.onerror = (e: ErrorEvent) => {
			finish(() => {
				worker.terminate();
				reject(new Error(e.message || 'detection worker script failed to load'));
			});
		};
		// OpenCV's URL is resolved on the page so a relative self-hosted path
		// (PUBLIC_SCANNER_ASSETS_URL=/vendor) works from inside the worker too.
		const cvUrl = new URL(openCvUrl(), window.location.href).href;
		worker.postMessage({ type: 'init', openCvUrl: cvUrl });
	});
}

/** Worker-backed detector; falls back to the main thread when the worker dies mid-session. */
function createWorkerDetector(worker: Worker, log?: (msg: string) => void): QuickDetector {
	let busy = false;
	let nextId = 1;
	let pending: { id: number; resolve: (d: QuickDetection) => void; timer: ReturnType<typeof setTimeout> } | null = null;
	let dead = false;
	const fallback = createMainThreadDetector();

	const settle = (result: QuickDetection) => {
		if (!pending) return;
		clearTimeout(pending.timer);
		const { resolve } = pending;
		pending = null;
		busy = false;
		resolve(result);
	};

	worker.onmessage = (e: MessageEvent) => {
		const msg = e.data as WorkerResult | { type: 'log'; message: string };
		if (msg.type === 'log') {
			log?.(String(msg.message));
			return;
		}
		if (msg.type !== 'result' || !pending || msg.id !== pending.id) return;
		if (msg.error) log?.(`detection worker error: ${msg.error}`);
		settle({ rects: msg.rects ?? [], quality: msg.quality ?? EMPTY_QUALITY });
	};
	worker.onerror = (e: ErrorEvent) => {
		log?.(`detection worker crashed (${e.message}); continuing on the main thread`);
		dead = true;
		worker.terminate();
		settle({ rects: [], quality: EMPTY_QUALITY });
	};

	return {
		get mode() {
			return dead ? ('main' as const) : ('worker' as const);
		},
		get busy() {
			return dead ? fallback.busy : busy;
		},
		async detect(canvas, opts = {}) {
			if (dead) return fallback.detect(canvas, opts);
			if (busy) return { rects: [], quality: EMPTY_QUALITY };
			const pixels = readPixels(canvas);
			if (!pixels) return { rects: [], quality: EMPTY_QUALITY };
			busy = true;
			const id = nextId++;
			return new Promise<QuickDetection>((resolve) => {
				const timer = setTimeout(() => {
					log?.('detection worker timed out; continuing on the main thread');
					dead = true;
					worker.terminate();
					settle({ rects: [], quality: EMPTY_QUALITY });
				}, WORKER_DETECT_TIMEOUT_MS);
				pending = { id, resolve, timer };
				// Transfer the pixel buffer instead of copying ~1 MB per frame.
				const buffer = pixels.data.buffer;
				worker.postMessage({ type: 'detect', id, width: pixels.width, height: pixels.height, buffer, opts }, [buffer]);
			});
		},
		dispose() {
			dead = true;
			worker.terminate();
			settle({ rects: [], quality: EMPTY_QUALITY });
		}
	};
}

/**
 * Create the live detector: the Web Worker when it starts within the
 * timeout, otherwise the main thread. Never rejects — the reason for a
 * fallback goes to `log`.
 */
export async function createQuickDetector(opts: QuickDetectorOptions = {}): Promise<QuickDetector> {
	const preferWorker = opts.preferWorker ?? true;
	if (preferWorker && typeof window !== 'undefined') {
		try {
			const worker = await startWorker(opts.workerUrl ?? DETECT_WORKER_URL, opts.log);
			opts.log?.('detector: Web Worker (OpenCV.js off the main thread)');
			return createWorkerDetector(worker, opts.log);
		} catch (err) {
			opts.log?.(`detector: main thread (${(err as Error).message})`);
		}
	} else {
		opts.log?.('detector: main thread');
	}
	return createMainThreadDetector();
}
