// Build first. All requests are anonymous and use an isolated synthetic database.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { SCHEMA_SQL } from '../src/lib/server/schema-sql.ts';

const dir = resolve('data', `seo-check-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const dbPath = resolve(dir, 'mtg.db');
const db = new Database(dbPath);
db.exec(SCHEMA_SQL);
const insert = db.prepare(`INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,price_eur)
	VALUES (?,?,'Fixture Card','tst','Test Set',?,'common','Creature',1)`);
db.transaction(() => {
	for (let i = 1; i <= 81; i++) {
		const id = `fixture-${String(i).padStart(3, '0')}`;
		insert.run(id, id, String(i));
	}
})();
db.prepare('UPDATE cards SET image_uri = ? WHERE id = ?').run('/favicon.ico', 'fixture-001');
db.close();

const port = Number(process.env.SEO_CHECK_PORT || 5191);
const origin = `http://127.0.0.1:${port}`;
const publicOrigin = 'https://mtg-collector.com';
const server = spawn(process.execPath, ['build/index.js'], {
	env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin,
		MTG_DB_PATH: dbPath, DISABLE_PRICE_UPDATES: '1' },
	windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
let browser;
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; console.log(`PASS ${message}`); }
const locations = xml => [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
try {
	let ready = false;
	for (let i = 0; i < 150; i++) {
		if (server.exitCode !== null) throw new Error(output);
		try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	assert.ok(ready, output);
	const index = await fetch(origin + '/sitemap.xml', { redirect: 'manual' });
	check(index.status === 200 && index.headers.get('content-type').includes('application/xml'), 'sitemap is public XML, without a login redirect');
	const indexXml = await index.text();
	check(indexXml.includes('<sitemapindex'), 'root sitemap is an index');
	let urls = [];
	for (const part of locations(indexXml)) {
		const response = await fetch(origin + new URL(part).pathname, { redirect: 'manual' });
		assert.equal(response.status, 200);
		assert.match(response.headers.get('content-type'), /application\/xml/);
		const xml = await response.text();
		urls.push(...locations(xml));
	}
	check(urls.length === 87 && new Set(urls).size === 87, 'all 81 printings and six public pages appear exactly once');
	for (const path of ['/sitemap-cards-0.xml', '/sitemap-cards-2.xml', '/sitemap-unknown.xml']) {
		check((await fetch(origin + path, { redirect: 'manual' })).status === 404, `missing sitemap returns 404: ${path}`);
	}
	for (const path of ['/collection', '/prices', '/admin']) {
		const response = await fetch(origin + path, { redirect: 'manual' });
		check(response.status === 302 && response.headers.get('location') === '/login', `private route remains protected: ${path}`);
	}
	const robots = await (await fetch(origin + '/robots.txt')).text();
	check(robots.includes(`Sitemap: ${publicOrigin}/sitemap.xml`) && robots.includes('Disallow: /admin'), 'robots points to the sitemap and excludes admin');

	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, headless: true });
	const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
	await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
	const page = await context.newPage();
	await page.goto(origin + '/cards');
	check(await page.locator('link[rel="canonical"]').getAttribute('href') === publicOrigin + '/cards', 'first catalogue page has its clean canonical');
	const firstPageCards = await page.locator('a.card-shell').evaluateAll(links => links.map(link => link.getAttribute('href')));
	await page.getByRole('link', { name: 'Next', exact: true }).click();
	check(new URL(page.url()).searchParams.get('page') === '2', 'pagination works with JavaScript disabled');
	check(await page.locator('link[rel="canonical"]').getAttribute('href') === publicOrigin + '/cards?page=2', 'second catalogue page has its own canonical');
	const secondPageCards = await page.locator('a.card-shell').evaluateAll(links => links.map(link => link.getAttribute('href')));
	check(firstPageCards.length === 40 && secondPageCards.length === 40 && !firstPageCards.some(id => secondPageCards.includes(id)), 'equal card names have stable pagination without duplicates');
	await page.goto(origin + '/cards?set=tst&page=2&utm_source=test');
	check(await page.locator('meta[name="robots"]').getAttribute('content') === 'noindex, follow', 'filtered pages expose noindex in server-rendered HTML');
	check(await page.locator('link[rel="canonical"]').getAttribute('href') === publicOrigin + '/cards?set=tst&page=2', 'filtered canonical preserves results and drops tracking');
	await page.getByRole('link', { name: 'Prev', exact: true }).click();
	check(new URL(page.url()).searchParams.get('set') === 'tst' && !new URL(page.url()).searchParams.has('page'), 'pagination preserves filters and removes page=1');
	for (const query of ['page=0', 'page=-1', 'page=abc', 'page=4', 'page=99999999999999999999']) {
		check((await fetch(origin + '/cards?' + query)).status === 404, `invalid catalogue page is not a soft 404: ${query}`);
	}
	check((await fetch(origin + '/cards?q=%22%22')).status === 200, 'empty quoted search does not cause a crawler-facing server error');
	await page.goto(origin + '/cards?q=NothingMatchesThisFixture');
	check((await page.locator('body').innerText()).includes('page 1 of 1'), 'empty search has a coherent page count');
	await page.goto(origin + '/cards/fixture-001');
	check((await page.title()).includes('Test Set #1'), 'printing title identifies its set and collector number');
	const schema = await page.locator('script[type="application/ld+json"]').textContent();
	const graph = JSON.parse(schema)['@graph'];
	check(graph.some(item => item['@type'] === 'BreadcrumbList') && !schema.includes('Offer') && !schema.includes('InStock'), 'valid JSON-LD describes navigation without inventing a sales offer');
	check(await page.getByRole('navigation', { name: 'Breadcrumb' }).isVisible(), 'structured breadcrumbs match visible navigation');
	check(await page.locator('meta[property="og:type"]').count() === 1, 'Open Graph type is not duplicated');
	check(await page.locator('meta[property="og:image"]').getAttribute('content') === publicOrigin + '/favicon.ico', 'local social images become absolute public URLs');
	check((await fetch(origin + '/cards/does-not-exist')).status === 404, 'missing card retains its real 404 status');
	await page.goto(origin + '/');
	check(JSON.parse(await page.locator('script[type="application/ld+json"]').textContent())['@type'] === 'WebSite', 'home page declares its site identity');
	check(await page.getByRole('heading', { level: 1 }).innerText() === 'MTG card scanner and collection tracker', 'home page explains the app in visible content');
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'home page fits a mobile viewport');
	await page.screenshot({ path: resolve(dir, 'home-mobile.png'), fullPage: true });
	await page.goto(origin + '/scan');
	const description = await page.locator('meta[name="description"]').getAttribute('content');
	check(description.includes('German') && !description.includes('foil detection'), 'scanner snippet describes supported use without guaranteed foil recognition');
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'scanner introduction fits a mobile viewport');
	await page.screenshot({ path: resolve(dir, 'scan-mobile.png'), fullPage: true });
	await context.close();

	// Check client-side route changes too: metadata must update after hydration.
	const client = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await client.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
	const hydrated = await client.newPage();
	const errors = [];
	hydrated.on('pageerror', error => errors.push(error.message));
	await hydrated.goto(origin + '/cards');
	await hydrated.getByRole('link', { name: 'Next', exact: true }).click();
	await hydrated.waitForURL('**/cards?page=2');
	await hydrated.waitForFunction(() => document.querySelector('link[rel="canonical"]')?.href.endsWith('/cards?page=2'));
	check(true, 'client navigation updates the canonical URL');
	check(errors.length === 0, 'client pagination has no runtime errors');
	await client.close();
	console.log(`${checks} SEO checks passed. Screenshots: ${dir}`);
} finally {
	await browser?.close();
	const exited = once(server, 'exit');
	if (server.exitCode === null) { server.kill(); await exited; }
}
