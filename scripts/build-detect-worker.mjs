// Bundle the live-scanner detection worker into a classic (non-module)
// worker script under static/, so it can `importScripts()` OpenCV.js in dev
// and in production alike. Vite serves module workers in dev, and module
// workers cannot use importScripts, hence the separate esbuild step.
//
// Runs automatically before `npm run dev` and `npm run build` (predev /
// prebuild); `static/scanner/` is gitignored.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'static/scanner/detect-worker.js');
mkdirSync(dirname(outfile), { recursive: true });

await build({
	entryPoints: [resolve(root, 'src/lib/scanner/detect-worker.ts')],
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: 'es2020',
	outfile,
	sourcemap: false,
	minify: false,
	// Reported in the worker's ready message, so a scan log shows which bundle ran. The
	// script has a fixed URL and sat in a browser cache for hours after a deploy (2026-09-17).
	define: { __WORKER_BUILD__: JSON.stringify(new Date().toISOString()) },
	logLevel: 'info'
});
