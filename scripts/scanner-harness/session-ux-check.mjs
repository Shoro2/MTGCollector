// Browser integration check for the actual LiveScanner component.
// Run: node scripts/scanner-harness/session-ux-check.mjs
// Requires installed Playwright Chromium (or PLAYWRIGHT_CHROMIUM_PATH).
// No application server, database, network OCR or fixture files are needed.
// Camera pixels are real canvas frames; detector rectangles and quality are
// deterministic test doubles. Fingerprints, rearming, stability, frame selection,
// Svelte rendering and the parent busy prop all run the production code.
// This checks component integration, not OpenCV detection or OCR accuracy.
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const wrapper = `<script>
import LiveScanner from '${root.replaceAll('\\', '/')}/src/lib/components/LiveScanner.svelte';
let busy = $state(false);
window.sessionTest.setBusy = (value) => { busy = value; };
function capture(canvas, rects) {
  const p = canvas.getContext('2d').getImageData(640, 360, 1, 1).data;
  const card = p[0] > p[1] && p[0] > p[2] ? 'A' : p[2] > p[0] && p[2] > p[1] ? 'B' : 'C';
  window.sessionTest.captures.push({ card, pixel: [...p], rects: rects.length, at: performance.now() });
  busy = true;
}
</script>
<LiveScanner {busy} onCapture={capture} log={(message) => window.sessionTest.logs.push(message)} />`;

const detector = `
import { cardFingerprint } from '${root.replaceAll('\\', '/')}/src/lib/scanner/rearm.ts';
export const DETECT_WORKER_URL = '/unused-worker.js';
export async function createQuickDetector() {
 return { mode: 'main', busy: false, dispose() {}, async detect(canvas, opts = {}) {
  const s = window.sessionTest;
  if (s.invalid) return { valid:false, rects:[], quality:{sharpness:0,glare:0,score:0} };
  if (s.blank) return { rects:[], quality:{sharpness:0,glare:0,score:0} };
  const scale = canvas.width / 1280, x = 430 + s.offset, y = 70;
  const corners = [[x,y],[x+420,y],[x+420,y+580],[x,y+580]];
  const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  const fingerprint = cardFingerprint(pixels,canvas.width,canvas.height,corners.map(([a,b])=>[a*scale,b*scale]));
  const factor = scale * (opts.coordScale ?? 1);
  return { rects:[{corners:corners.map(([a,b])=>[a*factor,b*factor]),rect:{x:x*factor,y:y*factor,width:420*factor,height:580*factor},fingerprint,source:'fine'}],
    quality:{sharpness:s.card === 'A' ? 120 : 60,glare:0,score:s.card === 'A' ? 120 : 60} };
 }};
}`;

const bundle = await build({
 stdin: { contents: "import { mount } from 'svelte'; import App from 'session-wrapper'; mount(App,{target:document.body});", resolveDir: root },
 bundle: true, write: false, format: 'iife', platform: 'browser', conditions: ['browser'],
 plugins: [{ name: 'session-component', setup(b) {
  b.onResolve({ filter: /^session-wrapper$/ }, () => ({ path: 'session-wrapper', namespace: 'test' }));
  b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: compile(wrapper, { filename: 'SessionCheck.svelte', generate: 'client' }).js.code, resolveDir: root }));
  b.onResolve({ filter: /^\$app\/environment$/ }, () => ({ path: 'app-environment', namespace: 'mock' }));
  b.onResolve({ filter: /^\$lib\/scanner\/(detect|opencv)$/ }, (a) => ({ path: a.path.endsWith('/detect') ? 'detect' : 'opencv', namespace: 'mock' }));
  b.onResolve({ filter: /^\$lib\// }, (a) => ({ path: resolve(root, 'src/lib', a.path.slice(5) + '.ts') }));
  b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: a.path === 'detect' ? detector : a.path === 'opencv' ? 'export async function loadOpenCV() {}' : "export const version='session-check';", resolveDir: root }));
  b.onLoad({ filter: /\.svelte$/ }, async (a) => ({ contents: compile(await readFile(a.path, 'utf8'), { filename: a.path, generate: 'client' }).js.code, resolveDir: dirname(a.path) }));
 }}]
});

const server = createServer((_req, res) => {
 res.setHeader('Content-Type', 'text/html');
 res.end('<!doctype html><html><body><script>' + bundle.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
 browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
 const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
 const errors = [];
 page.on('pageerror', (e) => errors.push(e.message));
 await page.addInitScript(() => {
  const s = window.sessionTest = { card: 'A', offset: 0, brightness: 1, blank: false, invalid: false, captures: [], logs: [] };
  const camera = document.createElement('canvas'); camera.width = 1280; camera.height = 720;
  const c = camera.getContext('2d');
  function draw() {
   c.fillStyle = '#aaa'; c.fillRect(0, 0, 1280, 720);
   if (!s.blank) {
    c.save(); c.translate(430 + s.offset, 70);
    c.fillStyle = '#111'; c.fillRect(0, 0, 420, 580);
    let seed = s.card === 'A' ? 123 : s.card === 'B' ? 45678 : 96351;
    for (let y = 20; y < 560; y += 30) for (let x = 20; x < 400; x += 30) {
     seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
     const v = Math.round((35 + (seed >>> 24) * .7) * s.brightness);
     c.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')'; c.fillRect(x, y, 30, 30);
    }
    c.fillStyle = s.card === 'A' ? '#e02020' : s.card === 'B' ? '#2020e0' : '#20e020';
    c.fillRect(180, 260, 60, 60); c.restore();
   }
   requestAnimationFrame(draw);
  }
  draw();
  navigator.mediaDevices.getUserMedia = async () => camera.captureStream(30);
  navigator.mediaDevices.enumerateDevices = async () => [{kind:'videoinput',deviceId:'canvas',label:'Canvas camera'}];
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const count = () => page.evaluate(() => window.sessionTest.captures.length);
 const waitCount = (n) => page.waitForFunction((n) => window.sessionTest.captures.length >= n, n, { timeout: 15000 });
 const set = (changes) => page.evaluate((changes) => Object.assign(window.sessionTest, changes), changes);
 const release = () => page.evaluate(() => window.sessionTest.setBusy(false));
 const assert = (ok, message) => { if (!ok) throw new Error(message); console.log('ok  ' + message); };
 await waitCount(1);
 assert(await page.evaluate(() => window.sessionTest.captures[0].card === 'A'), 'first capture contains A');
 // Parent remains busy; jitter, exposure and a brief invalid detection must not unlock A.
 await set({offset: 3, brightness: .85}); await page.waitForTimeout(1100);
 await set({invalid: true}); await page.waitForTimeout(180); await set({invalid: false,offset: -3,brightness: 1.1});
 await page.waitForTimeout(1100); await set({offset: 0,brightness: 1}); await release();
 await page.waitForTimeout(1500);
 assert(await count() === 1, 'jitter, exposure and a transient detector error do not duplicate A');
 await page.getByRole('button', {name: 'Pause camera'}).click();
 await page.getByRole('button', {name: 'Resume camera'}).click();
 await page.waitForTimeout(2200);
 assert(await count() === 1, 'pause/resume does not duplicate A');
 await page.evaluate(() => window.sessionTest.setBusy(true));
 await set({card:'B'}); await page.waitForTimeout(2200);
 assert(await count() === 1, 'B is observed but not captured while OCR is busy');
 assert(await page.evaluate(() => window.sessionTest.logs.some((l) => l.includes('new card content'))), 'same-position replacement is observed during OCR');
 await release(); await waitCount(2);
 assert(await page.evaluate(() => window.sessionTest.captures[1].card === 'B'), 'replacement capture contains B pixels, not the sharper A frame');
 await release(); await page.waitForTimeout(2000);
 assert(await count() === 2, 'unchanged B is not captured twice');
 // Two replacements before OCR completes: the intermediate sharper A must not
 // survive as the best frame once the final C occupies the same rectangle.
 await page.evaluate(() => window.sessionTest.setBusy(true));
 await set({card:'A'}); await page.waitForTimeout(2200);
 await set({card:'C'}); await page.waitForTimeout(400);
 assert(await count() === 2, 'multiple replacements wait for OCR completion');
 await release(); await waitCount(3);
 assert(await page.evaluate(() => window.sessionTest.captures[2].card === 'C'), 'B to A to C during OCR captures final C, not intermediate A');
 // Returning to the original card is an observed replacement, but the frame
 // handed to the parent must contain that current card, not the intermediate one.
 await set({card:'A'}); await page.waitForTimeout(2200);
 await set({card:'C'}); await page.waitForTimeout(400);
 await release(); await waitCount(4);
 assert(await page.evaluate(() => window.sessionTest.captures[3].card === 'C'), 'C to A to C during OCR captures current C pixels');
 await release(); await page.waitForTimeout(1800);
 assert(await count() === 4, 'final unchanged card does not repeat');
 await page.getByLabel('Auto-capture').uncheck();
 await set({card:'A'}); await page.waitForTimeout(2200);
 await set({card:'B'}); await page.waitForTimeout(400);
 await page.getByRole('button',{name:'Capture now'}).click();
 await waitCount(5);
 assert(await page.evaluate(() => window.sessionTest.captures[4].card === 'B'), 'manual capture rejects a sharper cached frame of a different card');
 assert(errors.length === 0, 'no browser errors: ' + errors.join('; '));
 console.log('PASS: component integration with simulated detection and OCR busy state.');
} finally {
 await browser?.close();
 await new Promise((r) => server.close(r));
}
