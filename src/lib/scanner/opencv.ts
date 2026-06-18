/**
 * Lazily load OpenCV.js from its CDN. The global `window.cv` object is
 * available as soon as this resolves.
 *
 * Callers should treat the returned promise as a ready-signal — concurrent
 * callers share one script injection.
 */

const OPENCV_URL = 'https://docs.opencv.org/4.9.0/opencv.js';
const LOAD_TIMEOUT_MS = 30_000;

let loadPromise: Promise<void> | null = null;

export function loadOpenCV(): Promise<void> {
	if (typeof window !== 'undefined' && (window as any).cv?.Mat) {
		return Promise.resolve();
	}
	if (loadPromise) return loadPromise;

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
		const fail = (message: string) =>
			finish(() => {
				loadPromise = null;
				reject(new Error(message));
			});

		const script = document.createElement('script');
		script.src = OPENCV_URL;
		script.async = true;
		script.onload = () => {
			const check = () => {
				if (settled) return;
				if ((window as any).cv?.Mat) finish(() => resolve());
				else setTimeout(check, 100);
			};
			check();
		};
		script.onerror = () => fail('Failed to load OpenCV.js');
		document.head.appendChild(script);

		setTimeout(() => fail('OpenCV.js load timed out'), LOAD_TIMEOUT_MS);
	});

	return loadPromise;
}

/** True once window.cv.Mat is available. Reactive-safe check for UI gating. */
export function isOpenCVReady(): boolean {
	return typeof window !== 'undefined' && !!(window as any).cv?.Mat;
}
