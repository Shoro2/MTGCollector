/**
 * Lazily load OpenCV.js (from the CDN, or the self-hosted copy configured via
 * PUBLIC_SCANNER_ASSETS_URL — see assets.ts). The global `window.cv` object
 * is available as soon as this resolves.
 *
 * Callers should treat the returned promise as a ready-signal — concurrent
 * callers share one script injection. Readiness is detected by polling
 * `cv.Mat`: OpenCV's builds expose `cv` as an Emscripten module whose `then`
 * resolves with itself, so `await cv` would never settle.
 */

import { openCvUrl } from './assets.js';

const LOAD_TIMEOUT_MS = 30_000;

let loadPromise: Promise<void> | null = null;
/**
 * After a failed load, further attempts are refused for a short cooldown so a
 * caller in a hot loop (the live preview runs several times per second) can't
 * re-inject the script tag over and over. User-initiated retries pass `force`.
 */
const RETRY_COOLDOWN_MS = 2000;
let lastFailure: { at: number; error: Error } | null = null;

export function loadOpenCV(opts: { force?: boolean } = {}): Promise<void> {
	if (typeof window !== 'undefined' && (window as any).cv?.Mat) {
		return Promise.resolve();
	}
	if (loadPromise) return loadPromise;
	if (!opts.force && lastFailure && Date.now() - lastFailure.at < RETRY_COOLDOWN_MS) {
		return Promise.reject(lastFailure.error);
	}

	loadPromise = new Promise<void>((resolve, reject) => {
		// A single settle-guard covers all three outcomes (ready / script error /
		// timeout). Without the timeout, a CDN stall — script never fires onload,
		// or fires but cv.Mat never initializes — would leave the promise (and
		// every awaiting scan) hanging forever.
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};
		const script = document.createElement('script');
		const url = openCvUrl();
		const fail = (message: string) =>
			finish(() => {
				loadPromise = null;
				// Drop the dead tag so a retry starts from a clean slate.
				script.remove();
				const error = new Error(message);
				lastFailure = { at: Date.now(), error };
				reject(error);
			});

		script.src = url;
		script.async = true;
		script.onload = () => {
			const check = () => {
				if (settled) return;
				if ((window as any).cv?.Mat) {
					lastFailure = null;
					finish(() => resolve());
				} else setTimeout(check, 100);
			};
			check();
		};
		script.onerror = () => fail(`Failed to load OpenCV.js from ${url}`);
		document.head.appendChild(script);

		setTimeout(() => fail('OpenCV.js load timed out'), LOAD_TIMEOUT_MS);
	});

	return loadPromise;
}

/** True once window.cv.Mat is available. Reactive-safe check for UI gating. */
export function isOpenCVReady(): boolean {
	return typeof window !== 'undefined' && !!(window as any).cv?.Mat;
}
