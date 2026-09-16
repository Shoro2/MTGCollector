// Download the scanner's browser libraries from npm and place them under
// static/vendor/ in the layout documented in src/lib/scanner/assets.ts.
// Versions match the CDN defaults (OpenCV.js 4.9.0, tesseract.js 5,
// naptha/tessdata 4.0.0 English, onnxruntime-web 1.30.0, PaddleOCR PP-OCRv4
// recognition model from @gutenye/ocr-models 1.4.2). Set
// PUBLIC_SCANNER_ASSETS_URL=/vendor.
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tmp = mkdtempSync(join(tmpdir(), 'scanner-vendor-'));
try {
	execSync('npm init -y >/dev/null && npm i --no-audit --no-fund --silent @techstark/opencv-js@4.9.0-release.3 tesseract.js@5 @tesseract.js-data/eng onnxruntime-web@1.30.0 @gutenye/ocr-models@1.4.2', { cwd: tmp, stdio: 'inherit', shell: '/bin/sh' });
	const nm = join(tmp, 'node_modules');
	const out = 'static/vendor';
	mkdirSync(join(out, 'tesseract/core'), { recursive: true });
	mkdirSync(join(out, 'tesseract/lang'), { recursive: true });
	cpSync(join(nm, '@techstark/opencv-js/dist/opencv.js'), join(out, 'opencv.js'));
	for (const f of ['tesseract.esm.min.js', 'worker.min.js']) cpSync(join(nm, 'tesseract.js/dist', f), join(out, 'tesseract', f));
	for (const f of readdirSync(join(nm, 'tesseract.js-core')).filter((f) => f.startsWith('tesseract-core'))) cpSync(join(nm, 'tesseract.js-core', f), join(out, 'tesseract/core', f));
	cpSync(join(nm, '@tesseract.js-data/eng/4.0.0/eng.traineddata.gz'), join(out, 'tesseract/lang/eng.traineddata.gz'));
	mkdirSync(join(out, 'ort'), { recursive: true });
	mkdirSync(join(out, 'paddle'), { recursive: true });
	for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) cpSync(join(nm, 'onnxruntime-web/dist', f), join(out, 'ort', f));
	for (const f of ['ch_PP-OCRv4_rec_infer.onnx', 'ppocr_keys_v1.txt']) cpSync(join(nm, '@gutenye/ocr-models/assets', f), join(out, 'paddle', f));
	console.log(`scanner assets written to ${out}/ — set PUBLIC_SCANNER_ASSETS_URL=/vendor in .env`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
