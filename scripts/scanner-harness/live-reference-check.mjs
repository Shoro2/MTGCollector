// Real worker, warping, artwork API and OCR; a canvas stream replaces the camera.
// Requires a running production server against a scratch catalogue with art hashes.
// HARNESS_URL=http://127.0.0.1:5196 node scripts/scanner-harness/live-reference-check.mjs <catalogue.db> <output-directory>
// Downloads four reference images once. This establishes synthetic behavior, not phone accuracy.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const [catalogue, output, mode] = process.argv.slice(2);
const withoutReference = mode === '--without-reference';
if (!catalogue || !output || !process.env.HARNESS_URL) throw new Error('Pass a read-only catalogue, output directory and HARNESS_URL of a scratch server.');
mkdirSync(output, { recursive: true });
const db = new Database(resolve(catalogue), { readonly: true, fileMustExist: true });
const cards = [['aer', '154'], ['msc', '796'], ['rvr', '461'], ['wot', '24']].map(([set, number]) => {
	const card = db.prepare('SELECT name, id, image_uri FROM cards WHERE set_code=? AND collector_number=?').get(set, number);
	assert.ok(card, `Missing ${set} #${number}`);
	return card;
});
db.close();
for (const card of cards) {
	const file = resolve(output, `${card.id}.jpg`);
	if (!existsSync(file)) {
		const response = await fetch(card.image_uri, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'MTGCollector scanner verification', Accept: 'image/jpeg' } });
		assert.ok(response.ok, `Reference download: ${response.status}`);
		writeFileSync(file, Buffer.from(await response.arrayBuffer()));
		await new Promise(r => setTimeout(r, 200));
	}
	card.url = 'data:image/jpeg;base64,' + readFileSync(file).toString('base64');
}
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addInitScript((cards) => {
	const state = window.referenceTest = { index: 0, brightness: 1, offset: 0 };
	const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
	const ctx = canvas.getContext('2d');
	const images = cards.map(card => { const image = new Image(); image.src = card.url; return image; });
	const ready = Promise.all(images.map(image => image.decode()));
	function draw() {
		ctx.fillStyle = '#999'; ctx.fillRect(0, 0, 1280, 720);
		ctx.filter = `brightness(${state.brightness})`;
		if (images[state.index].complete) ctx.drawImage(images[state.index], 430 + state.offset, 65, 420, 586);
		ctx.filter = 'none'; requestAnimationFrame(draw);
	}
	ready.then(draw);
	Object.defineProperty(navigator, 'mediaDevices', { value: {
		async getUserMedia() { await ready; return canvas.captureStream(15); },
		async enumerateDevices() { return []; }
	} });
}, cards);
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
if (withoutReference) await page.addInitScript(() => {
 const realFetch = window.fetch.bind(window);
 window.fetch = (input, init) => {
  if (input === '/scan' && init?.method === 'POST' && JSON.parse(init.body)?.identityProbe) {
   return Promise.resolve(new Response(JSON.stringify({batch:[{identity:null}]}), {headers:{'Content-Type':'application/json'}}));
  }
  return realFetch(input, init);
 };
});
try {
	await page.goto(process.env.HARNESS_URL + '/scan');
	await page.getByRole('button', { name: 'Live camera', exact: true }).click();
	const receipt = page.locator('[data-capture-receipt]');
	for (let i = 0; i < cards.length; i++) {
		await page.evaluate(index => { window.referenceTest.index = index; }, i);
		if (withoutReference && i === 1) {
			await page.waitForTimeout(8000);
			assert.equal(await receipt.getAttribute('data-capture-receipt'), '1', 'negative control must remain blocked without reference evidence');
			console.log('PASS negative control: Hope of Ghirapur to Doomsday remains blocked without the reference channel');
			break;
		}
		await page.waitForFunction(({ id, name }) => {
			const r = document.querySelector(`[data-capture-receipt="${id}"]`);
			return r && r.getAttribute('data-capture-state') !== 'processing' && r.textContent.includes(name);
		}, { id: i + 1, name: cards[i].name }, { timeout: i === 0 ? 120000 : 30000 });
		console.log(`PASS captured ${i + 1}: ${cards[i].name}`);
		await page.evaluate(() => { window.referenceTest.brightness = 0.93; window.referenceTest.offset = 3; });
		await page.waitForTimeout(3300);
		assert.equal(await receipt.getAttribute('data-capture-receipt'), String(i + 1), 'held card must not repeat under mild exposure/corner changes');
		await page.evaluate(() => { window.referenceTest.brightness = 1; window.referenceTest.offset = 0; });
	}
	const log = await page.locator('pre').textContent();
	assert.match(log, /detector: Web Worker/);
	if (withoutReference) assert.doesNotMatch(log, /auto-capture rearmed:/);
	else assert.match(log, /auto-capture rearmed: reference artwork changed/, 'at least one replacement must exercise the reference channel');
	assert.deepEqual(errors, []);
	console.log(withoutReference ? 'PASS isolated reference-channel negative control' : 'PASS same-position reference replacements, no held-card duplicates, real worker and reference channel');
} finally {
	writeFileSync(resolve(output, withoutReference ? 'live-reference-disabled.log' : 'live-reference.log'), await page.locator('pre').textContent().catch(() => 'No log available'));
	await browser.close();
}
