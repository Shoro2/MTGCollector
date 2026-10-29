// Offline mode of the scanner, end to end (CLAUDE.md §6.5).
//
//   HARNESS_URL=http://localhost:4188 OFFLINE_CHECK_SERVER=./start-server.sh \
//     node scripts/scanner-harness/offline-check.mjs clip.y4m photo.jpg [screenshot-prefix]
//
// OFFLINE_CHECK_SERVER is a command that starts the production server (in the
// foreground) on HARNESS_URL. The script starts it, and for the offline phase
// stops it as well as switching the browser offline: Playwright's offline
// switch does not reach the service worker's own requests, so only a server
// that is really gone proves the cached copies are used.
//
// Needs a production build served against a seeded catalogue (README:
// "Offline mode"), ideally with PUBLIC_SCANNER_ASSETS_URL=/vendor so OpenCV.js
// is same-origin. `clip.y4m` is played as the camera (make-still-y4m.mjs of a
// synthetic card), `photo.jpg` is uploaded (make-synthetic.mjs).
//
// Walks through: no service worker before opting in -> "Make available
// offline" stores the page, the chunks, OpenCV and the detection worker ->
// offline, /scan still opens and other pages show the offline page -> a live
// capture and an upload are saved, not identified -> back online, both are
// identified by the normal pipeline and leave the queue -> "Turn off" removes
// the worker and its caches. Exits 1 when an expectation fails.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const [y4m, photo, shot = 'offline'] = process.argv.slice(2);
if (!y4m || !photo) throw new Error('usage: offline-check.mjs <clip.y4m> <photo.jpg> [screenshot-prefix]');
const base = process.env.HARNESS_URL ?? 'http://localhost:5173';
const serverCommand = process.env.OFFLINE_CHECK_SERVER;
if (!serverCommand) throw new Error('set OFFLINE_CHECK_SERVER to the command that starts the server on HARNESS_URL');
let server = null;
async function startServer() {
	server = spawn(serverCommand, { shell: true, stdio: 'ignore', detached: true });
	for (let i = 0; i < 60; i++) {
		if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error('server did not start');
}
async function stopServer() {
	if (!server) return;
	try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
	server = null;
	for (let i = 0; i < 40; i++) {
		if (!(await fetch(`${base}/api/health`).then((r) => r.ok, () => false))) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error('server did not stop');
}
await startServer();
const browser = await chromium.launch({
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
	args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`]
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['camera'], serviceWorkers: 'allow' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept()); // the discard / turn-off confirmations
const failures = [];
const expect = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const cardCount = () => page.evaluate(() => Array.from(document.querySelectorAll('h3')).filter((h) => /^Card \d+/.test(h.innerText.trim())).length);
const queued = () => page.evaluate(() => Number(document.querySelector('[data-offline-notice]')?.getAttribute('data-queued') ?? 0));
const cacheKeys = () => page.evaluate(() => caches.keys());
const cachedUrls = () => page.evaluate(async () => {
	const out = [];
	for (const key of await caches.keys()) for (const req of await (await caches.open(key)).keys()) out.push(`${key} ${new URL(req.url).pathname}${new URL(req.url).search}`);
	return out;
});
const swCount = () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);

try {
	// ---- online, before opting in ----
	await page.goto(`${base}/scan`, { waitUntil: 'networkidle' });
	expect((await swCount()) === 0, 'no service worker before offline mode is turned on');
	expect((await page.locator('link[rel="manifest"]').count()) === 1, 'the page links the web app manifest');
	const offlineMode = page.locator('[data-offline-mode]');
	expect((await offlineMode.getAttribute('data-offline-mode')) === 'off', 'offline mode starts off');

	// ---- turn it on ----
	await offlineMode.locator('summary').click();
	await page.getByRole('button', { name: 'Make available offline' }).click();
	await page.waitForFunction(() => document.querySelector('[data-offline-mode]')?.getAttribute('data-offline-mode') === 'on', null, { timeout: 60000 });
	expect(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the service worker controls the page');
	const keys = await cacheKeys();
	expect(keys.some((k) => k.startsWith('mtg-offline-app-')) && keys.includes('mtg-offline-pages'), `app and page caches exist (${keys.join(', ')})`);
	const urls = await cachedUrls();
	expect(urls.some((u) => / \/scan$/.test(u)), 'the scanner page is stored');
	expect(urls.some((u) => /\/opencv\.js$/.test(u)), 'OpenCV.js is stored');
	expect(urls.some((u) => /\/scanner\/detect-worker\.js\?v=/.test(u)), 'the detection worker of this build is stored');
	expect(!urls.some((u) => /tesseract|paddle|\/ort\//.test(u)), 'the OCR engines are not stored (identification needs a connection anyway)');
	expect(urls.filter((u) => u.includes('/_app/immutable/')).length > 10, 'the build chunks are stored');
	const usage = await page.evaluate(async () => (await navigator.storage.estimate()).usage);
	console.log(`     storage used by the site: ${(usage / 1048576).toFixed(1)} MB`);
	expect(await page.getByText(/Ready offline/).isVisible(), 'the panel says the scanner is ready offline');
	await page.screenshot({ path: `${shot}-enabled.png` });

	// ---- offline: the page opens, other pages fall back ----
	await stopServer();
	await context.setOffline(true);
	await page.reload({ waitUntil: 'load' });
	expect(await page.getByRole('heading', { name: 'MTG Card Scanner' }).isVisible(), 'offline, /scan still opens');
	await page.waitForSelector('[data-offline-notice][data-online="0"]', { timeout: 10000 });
	expect(await page.getByText('You are offline.').isVisible(), 'offline notice is shown');
	const other = await context.newPage();
	const otherErr = await other.goto(`${base}/collection`, { waitUntil: 'load' }).then(() => '', (e) => e.message);
	const otherText = await other.evaluate(() => document.body?.innerText ?? '').catch((e) => `(${e.message})`);
	expect(/You are offline/.test(otherText), `another page shows the offline page (${otherErr || otherText.slice(0, 80).replace(/\s+/g, ' ')})`);
	await other.close();

	// ---- offline live capture ----
	await page.getByRole('button', { name: 'Live camera' }).click();
	await page.waitForFunction(() => document.querySelector('[data-capture-receipt]')?.getAttribute('data-capture-state') === 'queued', null, { timeout: 90000 });
	const detectorLine = await page.evaluate(() => (document.querySelector('pre')?.textContent ?? '').split('\n').find((l) => l.includes('detector:')) ?? '');
	console.log(`     ${detectorLine.trim()}`);
	expect(/Web Worker/.test(detectorLine), 'offline, the detection worker starts (OpenCV from the cache)');
	expect((await queued()) === 1, `the live capture is saved (${await queued()} waiting)`);
	expect((await cardCount()) === 0, 'nothing is identified offline');
	expect(/Saved for later/.test(await page.locator('[data-capture-receipt]').innerText()), 'the receipt says the capture was saved for later');
	await page.screenshot({ path: `${shot}-queued.png` });
	await page.getByRole('button', { name: 'Pause camera' }).click();

	// ---- offline upload ----
	await page.getByRole('button', { name: 'Single card' }).first().click();
	await page.setInputFiles('input[type=file]', photo);
	await page.waitForFunction(() => Number(document.querySelector('[data-offline-notice]')?.getAttribute('data-queued') ?? 0) === 2, null, { timeout: 15000 });
	expect((await queued()) === 2, 'the uploaded photo is saved too');

	// ---- a reload while offline keeps the queue ----
	await page.reload({ waitUntil: 'load' });
	await page.waitForSelector('[data-offline-notice][data-queued="2"]', { timeout: 10000 });
	expect(true, 'the queue survives a reload');

	// ---- back online: the queue is identified ----
	await startServer();
	await context.setOffline(false);
	await page.waitForFunction(() => !document.querySelector('[data-offline-notice]'), null, { timeout: 180000 });
	const cards = await cardCount();
	const states = await page.evaluate(() => Array.from(document.querySelectorAll('[data-state]')).map((e) => `${e.getAttribute('data-state')}/${e.getAttribute('data-printing-state')}`));
	expect(cards >= 2, `both saved captures were identified (${cards} card blocks)`);
	expect(states.filter((s) => s === 'confirmed/confirmed').length >= 2, `with confirmed identities and printings (${states.join(', ')})`);
	const log = await page.evaluate(() => document.querySelector('pre')?.textContent ?? '');
	expect(/Saved capture 1 of 2/.test(log) && /Saved capture 2 of 2/.test(log), 'the log names both saved captures');
	expect(/mode=live \(saved capture\)/.test(log) && /mode=single \(saved capture\)/.test(log), 'each keeps the mode it was taken in');
	await page.screenshot({ path: `${shot}-identified.png`, fullPage: true });

	// ---- the server goes away while the browser still thinks it is online ----
	await stopServer();
	await page.getByRole('button', { name: 'Single card' }).first().click().catch(() => {});
	await page.setInputFiles('input[type=file]', photo);
	await page.waitForFunction(() => Number(document.querySelector('[data-offline-notice]')?.getAttribute('data-queued') ?? 0) === 1, null, { timeout: 120000 });
	expect(await page.getByText(/connection dropped/).isVisible(), 'a scan whose lookups fail is saved for later, not reported as unknown cards');
	await startServer();
	await page.getByRole('button', { name: 'Identify now' }).click();
	await page.waitForFunction(() => !document.querySelector('[data-offline-notice]'), null, { timeout: 120000 });
	const after = await page.evaluate(() => Array.from(document.querySelectorAll('[data-state]')).map((e) => e.getAttribute('data-state')));
	expect(after.includes('confirmed'), `"Identify now" identifies it (${after.join(', ')})`);

	// ---- turn it off ----
	await page.locator('[data-offline-mode] summary').click();
	await page.getByRole('button', { name: 'Turn off offline mode' }).click();
	await page.waitForFunction(() => document.querySelector('[data-offline-mode]')?.getAttribute('data-offline-mode') === 'off', null, { timeout: 15000 });
	expect((await swCount()) === 0, 'turning off unregisters the service worker');
	expect(!(await cacheKeys()).some((k) => k.startsWith('mtg-offline-')), 'and deletes its caches');
} catch (err) {
	expect(false, `unexpected: ${err.message}`);
}
expect(errors.length === 0, `no page errors (${errors.join(' | ')})`);
await browser.close();
await stopServer().catch(() => {});
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall offline checks passed');
process.exit(failures.length ? 1 : 0);
