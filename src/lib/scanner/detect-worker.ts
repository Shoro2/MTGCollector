/**
 * Detection Web Worker for the live scanner.
 *
 * Bundled by `scripts/build-detect-worker.mjs` (esbuild, IIFE) into
 * `static/scanner/detect-worker.js` and started as a *classic* worker, so
 * `importScripts()` can load the same OpenCV.js build the page uses (CDN or
 * the self-hosted copy) — a module worker could not. Runs `detectOnPixels()`
 * from `quick-rects.ts` on the RGBA buffers the page transfers in.
 *
 * Protocol (all messages are plain objects):
 *   page -> worker  { type: 'init', openCvUrl }
 *   worker -> page  { type: 'ready' } | { type: 'error', message }
 *   page -> worker  { type: 'detect', id, width, height, buffer, opts }
 *   worker -> page  { type: 'result', id, rects, quality, ms, error? }
 */

import { detectOnPixels } from './quick-rects.js';

declare function importScripts(...urls: string[]): void;

type InitMessage = { type: 'init'; openCvUrl: string };
type DetectMessage = { type: 'detect'; id: number; width: number; height: number; buffer: ArrayBuffer; opts: Record<string, unknown> };

const scope = globalThis as unknown as {
	cv?: any;
	postMessage: (message: unknown) => void;
	onmessage: ((e: MessageEvent<InitMessage | DetectMessage>) => void) | null;
};

const CV_READY_TIMEOUT_MS = 30_000;

let cv: any = null;

/**
 * Load OpenCV.js into the worker scope and wait for the WASM runtime. The
 * promise deliberately resolves with nothing: the Emscripten module is a
 * thenable whose `then` never settles, so resolving with (or awaiting) `cv`
 * itself would hang forever — read `scope.cv` after the await instead.
 */
function loadOpenCVInWorker(url: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const t0 = Date.now();
		try {
			importScripts(url);
		} catch (err) {
			reject(new Error(`importScripts failed for ${url}: ${(err as Error).message ?? err}`));
			return;
		}
		scope.postMessage({ type: 'log', message: `worker: OpenCV script imported in ${Date.now() - t0} ms (cv ${typeof scope.cv})` });
		const started = Date.now();
		let lastNote = started;
		const check = () => {
			if (scope.cv?.Mat) {
				scope.postMessage({ type: 'log', message: `worker: OpenCV runtime ready after ${Date.now() - t0} ms` });
				resolve();
			} else if (Date.now() - started > CV_READY_TIMEOUT_MS) {
				reject(new Error('OpenCV.js did not initialise in the worker'));
			} else {
				if (Date.now() - lastNote > 5000) {
					lastNote = Date.now();
					scope.postMessage({ type: 'log', message: `worker: still waiting for the OpenCV runtime (${Math.round((Date.now() - started) / 1000)} s, cv ${typeof scope.cv}, Mat ${typeof scope.cv?.Mat})` });
				}
				setTimeout(check, 50);
			}
		};
		check();
	});
}

scope.onmessage = async (e) => {
	const msg = e.data;
	if (msg.type === 'init') {
		try {
			await loadOpenCVInWorker(msg.openCvUrl);
			cv = scope.cv;
			scope.postMessage({ type: 'ready' });
		} catch (err) {
			scope.postMessage({ type: 'error', message: (err as Error).message ?? String(err) });
		}
		return;
	}
	if (msg.type === 'detect') {
		const t0 = Date.now();
		if (!cv) {
			scope.postMessage({ type: 'result', id: msg.id, rects: [], quality: null, ms: 0, error: 'OpenCV not loaded' });
			return;
		}
		try {
			const rgba = new Uint8ClampedArray(msg.buffer);
			const { rects, quality } = detectOnPixels(cv, rgba, msg.width, msg.height, msg.opts);
			scope.postMessage({ type: 'result', id: msg.id, rects, quality, ms: Date.now() - t0 });
		} catch (err) {
			scope.postMessage({ type: 'result', id: msg.id, rects: [], quality: null, ms: Date.now() - t0, error: (err as Error).message ?? String(err) });
		}
	}
};
