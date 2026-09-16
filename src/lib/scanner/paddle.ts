/**
 * PaddleOCR PP-OCRv4 text recognition in the browser via onnxruntime-web
 * (WASM, single thread, no worker). A second OCR engine for name bars: on 75
 * real-photo cards it read 64 names where Tesseract's four passes read 65,
 * and the union is 72 — the engines fail on different cards. Recognition
 * only: the scanner hands it single text lines, so the detection and
 * orientation models are not needed. Loaded lazily on first use (~25 MB);
 * every failure is swallowed and reported as "unavailable" so a scan never
 * breaks because of it.
 */
import { paddleAssets } from './assets.js';
import { ctcDecode } from './ctc.js';
import { withTimeout } from './timeout.js';

export { ctcDecode };

type OrtTensor = { dims: number[]; data: Float32Array };
type OrtSession = {
	inputNames: string[];
	outputNames: string[];
	run: (feeds: Record<string, unknown>) => Promise<Record<string, OrtTensor>>;
};
type OrtModule = {
	env: { wasm: { wasmPaths: string; numThreads: number; proxy: boolean } };
	InferenceSession: { create: (url: string, options: Record<string, unknown>) => Promise<OrtSession> };
	Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
};
type Paddle = { ort: OrtModule; session: OrtSession; dict: string[] };

/** Input height of the PP-OCR recognition model. */
export const REC_HEIGHT = 48;
/** Widest input the model is fed (a name bar is far narrower). */
export const REC_MAX_WIDTH = 1600;

let loading: Promise<Paddle | null> | null = null;
let lastFailure = 0;
/** Deadline for runtime + model + dictionary; generous for slow mobile links, finite for a stalled CDN. */
const LOAD_TIMEOUT_MS = 90_000;

/** Load runtime, model and dictionary once; null when unavailable (retried after 30 s). */
export async function loadPaddle(): Promise<Paddle | null> {
	if (loading) return loading;
	if (Date.now() - lastFailure < 30_000) return null;
	loading = (async () => {
		try {
			const assets = paddleAssets();
			// ~25 MB of runtime and model; a stalled download must not hang the scan.
			return await withTimeout((async (): Promise<Paddle> => {
				const ort = (await import(/* @vite-ignore */ assets.ortScript)) as OrtModule;
				ort.env.wasm.wasmPaths = assets.ortWasmDir;
				ort.env.wasm.numThreads = 1;
				ort.env.wasm.proxy = false;
				const [session, keysText] = await Promise.all([
					ort.InferenceSession.create(assets.recModel, { executionProviders: ['wasm'] }),
					fetch(assets.keys).then((r) => r.text())
				]);
				const keys = keysText.split('\n');
				if (keys[keys.length - 1] === '') keys.pop();
				return { ort, session, dict: ['', ...keys, ' '] };
			})(), LOAD_TIMEOUT_MS, 'PaddleOCR engine load');
		} catch (err) {
			console.warn('PaddleOCR unavailable:', err);
			lastFailure = Date.now();
			loading = null;
			return null;
		}
	})();
	return loading;
}

/** Resize a line image to the model height and normalise RGB to [-1, 1] in NCHW order. */
export function preprocessLine(img: CanvasImageSource, width: number, height: number): { data: Float32Array; width: number } {
	const w = Math.max(16, Math.min(REC_MAX_WIDTH, Math.round((width * REC_HEIGHT) / height)));
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = REC_HEIGHT;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('canvas 2d context unavailable');
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(img, 0, 0, w, REC_HEIGHT);
	const px = ctx.getImageData(0, 0, w, REC_HEIGHT).data;
	const data = new Float32Array(3 * REC_HEIGHT * w);
	const plane = REC_HEIGHT * w;
	for (let y = 0; y < REC_HEIGHT; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const o = y * w + x;
			data[o] = (px[i] / 255 - 0.5) / 0.5;
			data[plane + o] = (px[i + 1] / 255 - 0.5) / 0.5;
			data[2 * plane + o] = (px[i + 2] / 255 - 0.5) / 0.5;
		}
	}
	return { data, width: w };
}

/** Recognise single text lines given as image URLs; '' for anything that fails. */
export async function recognizeLines(urls: string[]): Promise<string[]> {
	const paddle = await loadPaddle();
	if (!paddle) return urls.map(() => '');
	const out: string[] = [];
	for (const url of urls) {
		try {
			const img = new Image();
			img.src = url;
			await img.decode();
			const { data, width } = preprocessLine(img, img.width, img.height);
			const input = new paddle.ort.Tensor('float32', data, [1, 3, REC_HEIGHT, width]);
			const result = await paddle.session.run({ [paddle.session.inputNames[0]]: input });
			const tensor = result[paddle.session.outputNames[0]];
			const [, steps, classes] = tensor.dims;
			out.push(ctcDecode(tensor.data, steps, classes, paddle.dict).text);
		} catch {
			out.push('');
		}
	}
	return out;
}
