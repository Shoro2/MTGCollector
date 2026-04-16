/**
 * Lazily load OpenCV.js from its CDN. The global `window.cv` object is
 * available as soon as this resolves.
 *
 * Callers should treat the returned promise as a ready-signal — concurrent
 * callers share one script injection.
 */

const OPENCV_URL = 'https://docs.opencv.org/4.9.0/opencv.js';

let loadPromise: Promise<void> | null = null;

export function loadOpenCV(): Promise<void> {
	if (typeof window !== 'undefined' && (window as any).cv?.Mat) {
		return Promise.resolve();
	}
	if (loadPromise) return loadPromise;

	loadPromise = new Promise<void>((resolve, reject) => {
		const script = document.createElement('script');
		script.src = OPENCV_URL;
		script.async = true;
		script.onload = () => {
			const check = () => {
				if ((window as any).cv?.Mat) {
					resolve();
				} else {
					setTimeout(check, 100);
				}
			};
			check();
		};
		script.onerror = () => {
			loadPromise = null;
			reject(new Error('Failed to load OpenCV.js'));
		};
		document.head.appendChild(script);
	});

	return loadPromise;
}

/** True once window.cv.Mat is available. Reactive-safe check for UI gating. */
export function isOpenCVReady(): boolean {
	return typeof window !== 'undefined' && !!(window as any).cv?.Mat;
}
