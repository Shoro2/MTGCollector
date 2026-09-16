/**
 * Where the browser-side scanner libraries are loaded from.
 *
 * By default OpenCV.js and Tesseract.js come from public CDNs. Setting
 * `PUBLIC_SCANNER_ASSETS_URL` (e.g. `/vendor` for files served from
 * `static/vendor/`, or a full URL) switches every library to a self-hosted
 * copy with this layout:
 *
 *   <base>/opencv.js                          docs.opencv.org build (4.9.0)
 *   <base>/tesseract/tesseract.esm.min.js     tesseract.js@5 ESM bundle
 *   <base>/tesseract/worker.min.js            tesseract.js@5 worker
 *   <base>/tesseract/core/                    tesseract.js-core files (*.wasm.js, *.wasm)
 *   <base>/tesseract/lang/eng.traineddata.gz  language data (naptha/tessdata 4.0.0)
 *
 * Used for offline development, sandboxed CI and privacy-sensitive
 * deployments; the CDN defaults stay untouched when the variable is unset.
 */
import { env } from '$env/dynamic/public';

const DEFAULT_OPENCV_URL = 'https://docs.opencv.org/4.9.0/opencv.js';
const DEFAULT_TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js';

/** Configured base URL without a trailing slash, or '' when the CDNs are used. */
export function scannerAssetsBase(): string {
	const base = env.PUBLIC_SCANNER_ASSETS_URL?.trim() ?? '';
	return base.replace(/\/+$/, '');
}

export function openCvUrl(): string {
	const base = scannerAssetsBase();
	return base ? `${base}/opencv.js` : DEFAULT_OPENCV_URL;
}

export type TesseractAssets = {
	/** URL of the ESM bundle to `import()`. */
	script: string;
	/** Extra options for `createWorker`; empty when the bundle's CDN defaults apply. */
	workerOptions: { workerPath?: string; corePath?: string; langPath?: string; gzip?: boolean };
};

export function tesseractAssets(): TesseractAssets {
	const base = scannerAssetsBase();
	if (!base) return { script: DEFAULT_TESSERACT_URL, workerOptions: {} };
	return {
		script: `${base}/tesseract/tesseract.esm.min.js`,
		workerOptions: {
			workerPath: `${base}/tesseract/worker.min.js`,
			corePath: `${base}/tesseract/core`,
			langPath: `${base}/tesseract/lang`,
			gzip: true
		}
	};
}
