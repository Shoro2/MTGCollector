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
 *   <base>/ort/ort.wasm.min.mjs               onnxruntime-web 1.30 (WASM build) + ort-wasm-simd-threaded.{mjs,wasm}
 *   <base>/paddle/ch_PP-OCRv4_rec_infer.onnx  PaddleOCR PP-OCRv4 recognition model + ppocr_keys_v1.txt
 *
 * Used for offline development, sandboxed CI and privacy-sensitive
 * deployments; the CDN defaults stay untouched when the variable is unset.
 */
import { env } from '$env/dynamic/public';

const DEFAULT_OPENCV_URL = 'https://docs.opencv.org/4.9.0/opencv.js';
const DEFAULT_TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js';
const DEFAULT_ORT_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const DEFAULT_PADDLE_DIR = 'https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/';

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

export type PaddleAssets = {
	/** ESM entry of onnxruntime-web (WASM build). */
	ortScript: string;
	/** Directory the runtime loads its .wasm/.mjs helpers from (trailing slash). */
	ortWasmDir: string;
	/** PP-OCRv4 recognition model (ONNX) and its character dictionary. */
	recModel: string;
	keys: string;
};

/** PaddleOCR recognition assets: ~14 MB runtime + ~11 MB model, fetched lazily on first use. */
export function paddleAssets(): PaddleAssets {
	const base = scannerAssetsBase();
	const ortDir = base ? `${base}/ort/` : DEFAULT_ORT_DIR;
	const paddleDir = base ? `${base}/paddle/` : DEFAULT_PADDLE_DIR;
	return {
		ortScript: `${ortDir}ort.wasm.min.mjs`,
		ortWasmDir: ortDir,
		recModel: `${paddleDir}ch_PP-OCRv4_rec_infer.onnx`,
		keys: `${paddleDir}ppocr_keys_v1.txt`
	};
}
