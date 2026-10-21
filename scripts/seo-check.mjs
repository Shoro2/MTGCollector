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
// Printing ids are Scryfall UUIDs (the /cards/<id> route only matches that shape); three
// printings per card, all named alike, plus one card whose name has an apostrophe.
const printingId = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const oracleId = (k) => `a${String(k).padStart(7, '0')}-0000-4000-8000-000000000000`;
const insert = db.prepare(`INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,price_eur,layout,released_at)
	VALUES (?,?,?,'tst','Test Set',?,'common','Creature',?,'normal','2020-01-01')`);
db.transaction(() => {
	for (let i = 1; i <= 81; i++) insert.run(printingId(i), oracleId(Math.ceil(i / 3)), 'Fixture Card', String(i), 1);
	insert.run(printingId(82), oracleId(99), "Teferi's Protection", '82', 30);
	insert.run(printingId(83), oracleId(99), "Teferi's Protection", '83', 12.5);
	// A digital-only (Alchemy) card never has a price; its snippet must not promise one.
	db.prepare(`INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,oracle_text,layout,released_at,is_paper)
		VALUES (?,?,'Killian, Spotlight Chaser','yrf','Alchemy: Reality Fracture','1','uncommon','Legendary Creature — Human Bard',
		'Whenever a source you control deals noncombat damage to an opponent, seek a card with mana value equal to the damage dealt.','normal','2026-10-13',0)`)
		.run(printingId(84), oracleId(98));
})();
db.prepare('UPDATE cards SET image_uri = ? WHERE id = ?').run('/favicon.ico', printingId(1));
// Card images come from Scryfall's image server, as in production (the privacy check below expects it).
db.prepare('UPDATE cards SET image_uri = ? WHERE id = ?').run('https://cards.scryfall.io/normal/front/0/0/fixture.jpg', printingId(84));
// The FTS triggers only exist once the app has booted; index the fixture rows now.
db.exec("INSERT INTO cards_fts(cards_fts) VALUES('rebuild')");
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
	check(urls.length === 36 && new Set(urls).size === 36, 'all 29 cards and seven public pages appear exactly once');
	check(!urls.some((url) => /\/cards\/[0-9a-f]{8}-/.test(url)) && urls.includes(publicOrigin + '/cards/teferis-protection'), 'the sitemap lists card pages, not printings');
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
	await page.goto(origin + '/cards?q=' + encodeURIComponent("Teferi's"));
	check(await page.locator('a.card-shell').count() === 2, 'search finds a name with an apostrophe');
	await page.goto(origin + '/cards?unique=1&q=Teferi');
	check(await page.locator('a.card-shell').getAttribute('href') === '/cards/teferis-protection', 'unique catalogue tiles open the card page');
	await page.goto(origin + '/cards/teferis-protection');
	check(await page.locator('link[rel="canonical"]').getAttribute('href') === publicOrigin + '/cards/teferis-protection', 'card page is its own canonical');
	check(await page.title() === "Teferi's Protection: MTG price from €12.50, 2 printings", 'card page title leads with the lowest price and the printings');
	check((await page.locator('meta[name="description"]').getAttribute('content')).startsWith("Teferi's Protection (Creature): 2 printings from €12.50 with price history."), 'card snippet states printings and the lowest price');
	check(await page.getByRole('heading', { level: 1 }).innerText() === "Teferi's Protection", 'card page heading is the card name');
	check(await page.locator(`a[href="/cards/${printingId(82)}"]`).count() === 1 && await page.locator(`a[href="/cards/${printingId(83)}"]`).count() === 1, 'card page links every printing');
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'card page fits a mobile viewport');
	await page.goto(origin + '/cards/killian-spotlight-chaser');
	const digitalTitle = await page.title();
	check(digitalTitle === 'Killian, Spotlight Chaser: digital MTG card' && digitalTitle.length <= 60, 'a digital-only card title says what it is and fits 60 characters');
	const digitalSnippet = await page.locator('meta[name="description"]').getAttribute('content');
	check(digitalSnippet.includes('(Legendary Creature, Human Bard): digital card from Alchemy: Reality Fracture. Whenever') && !/price|€|\$/i.test(digitalSnippet) && digitalSnippet.length <= 155,
		'a digital-only card snippet promises no price and quotes the rules');
	check(!/[–—]/.test(digitalTitle + digitalSnippet), 'card snippets use no dashes, even where the type line has one');
	await page.screenshot({ path: resolve(dir, 'card-mobile.png'), fullPage: true });
	await page.goto(origin + '/cards/' + printingId(82));
	check(await page.locator('link[rel="canonical"]').getAttribute('href') === publicOrigin + '/cards/teferis-protection', 'printing page points its canonical to the card page');
	check(await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: "Teferi's Protection" }).count() === 1, 'printing breadcrumb links the card page');
	check(await page.locator('script[type="application/ld+json"]').textContent().then((t) => JSON.parse(t)['@graph'][0].url === publicOrigin + '/cards/' + printingId(82)), 'printing JSON-LD describes the printing URL itself');
	await page.goto(origin + '/cards/' + printingId(1));
	check((await page.title()).includes('Test Set #1'), 'printing title identifies its set and collector number');
	const schema = await page.locator('script[type="application/ld+json"]').textContent();
	const graph = JSON.parse(schema)['@graph'];
	check(graph.some(item => item['@type'] === 'BreadcrumbList') && !schema.includes('Offer') && !schema.includes('InStock'), 'valid JSON-LD describes navigation without inventing a sales offer');
	check(await page.getByRole('navigation', { name: 'Breadcrumb' }).isVisible(), 'structured breadcrumbs match visible navigation');
	check(await page.locator('meta[property="og:type"]').count() === 1, 'Open Graph type is not duplicated');
	check(await page.locator('meta[property="og:image"]').getAttribute('content') === publicOrigin + '/favicon.ico', 'local social images become absolute public URLs');
	check((await fetch(origin + '/cards/does-not-exist')).status === 404, 'missing card retains its real 404 status');
	check((await fetch(origin + '/cards/' + printingId(999))).status === 404, 'missing printing retains its real 404 status');
	await page.goto(origin + '/');
	check(JSON.parse(await page.locator('script[type="application/ld+json"]').textContent())['@type'] === 'WebSite', 'home page declares its site identity');
	check(await page.getByRole('heading', { level: 1 }).innerText() === 'MTG card scanner and collection tracker', 'home page explains the app in visible content');
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'home page fits a mobile viewport');
	await page.screenshot({ path: resolve(dir, 'home-mobile.png'), fullPage: true });
	check(await page.locator('main a[href="/portfolio-tracker"]').count() >= 1 && await page.locator('footer a[href="/portfolio-tracker"]').count() === 1,
		'home page and footer link the portfolio tracker');
	check(await page.locator('nav.app-nav a[href="/portfolio-tracker"]').count() === 1, 'the menu lists Portfolio for visitors');
	check((await fetch(origin + '/portfolio-tracker', { redirect: 'manual' })).status === 200, 'the portfolio tracker page is public');
	await page.goto(origin + '/portfolio-tracker');
	const trackerTitle = await page.title();
	check(trackerTitle.includes('MTG Portfolio Tracker') && trackerTitle.length <= 60, 'portfolio tracker title names the query and fits 60 characters');
	check(!/[–—]/.test(await page.locator('main').innerText() + trackerTitle), 'portfolio tracker copy uses no dashes');
	check((await page.locator('meta[name="description"]').getAttribute('content')).length <= 155, 'portfolio tracker description fits 155 characters');
	check(await page.locator('link[rel="canonical"]').getAttribute('href') === publicOrigin + '/portfolio-tracker', 'portfolio tracker page is its own canonical');
	check(await page.getByRole('heading', { level: 1 }).innerText() === 'Free MTG portfolio tracker', 'portfolio tracker heading states the offer');
	const trackerSchema = await page.locator('script[type="application/ld+json"]').textContent();
	check(JSON.parse(trackerSchema)['@graph'].some(item => item['@type'] === 'BreadcrumbList') && !/Offer|FAQPage/.test(trackerSchema),
		'portfolio tracker JSON-LD describes the page and its breadcrumb, no offer or FAQ markup');
	check(await page.getByRole('link', { name: 'Start tracking' }).first().getAttribute('href') === '/login', 'portfolio tracker sends visitors to sign in');
	check((await page.locator('main').innerText()).includes('Example data'), 'the dashboard preview is labelled as example data');
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'portfolio tracker page fits a mobile viewport');
	await page.screenshot({ path: resolve(dir, 'portfolio-tracker-mobile.png'), fullPage: true });
	await page.goto(origin + '/login');
	const loginText = await page.locator('main').innerText();
	check(loginText.includes('free to use') && loginText.includes('never sell your data') && !/[–—]/.test(loginText),
		'the sign in page says it is free and what happens with the data, without dashes');
	check(await page.locator('main a[href="/datenschutz"]').count() === 1, 'the sign in page links the privacy policy');
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
	await hydrated.getByRole('button', { name: 'Toggle navigation menu' }).click();
	await hydrated.getByRole('link', { name: 'Portfolio', exact: true }).click();
	await hydrated.waitForURL('**/portfolio-tracker');
	check(true, 'the mobile menu leads visitors to the portfolio tracker');
	check(errors.length === 0, 'client pagination has no runtime errors');
	await client.close();

	// Every third party the browser contacts must be named in the privacy policy, in both languages.
	// A new external host fails here until the policy and this list name it.
	const providers = {
		'analytics.mtg-collector.com': 'Plausible',
		'cards.scryfall.io': 'Scryfall',
		'docs.opencv.org': 'OpenCV',
		'cdn.jsdelivr.net': 'jsDelivr',
		'lh3.googleusercontent.com': 'Google',
		'accounts.google.com': 'Google'
	};
	const privacy = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	await privacy.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
	const external = new Set();
	privacy.on('request', request => {
		const url = new URL(request.url());
		if (url.origin !== origin && url.protocol.startsWith('http')) external.add(url.hostname);
	});
	const visitor = await privacy.newPage();
	for (const path of ['/', '/cards', '/cards/killian-spotlight-chaser', '/portfolio-tracker', '/login', '/contact', '/scan']) {
		await visitor.goto(origin + path);
		await visitor.waitForLoadState('networkidle');
	}
	await visitor.getByRole('button', { name: 'Live camera', exact: true }).first().click();
	await visitor.waitForLoadState('networkidle');
	await visitor.waitForFunction(() => performance.getEntriesByType('resource').some(e => e.name.includes('opencv')), null, { timeout: 15000 }).catch(() => {});
	check(['cards.scryfall.io', 'docs.opencv.org', 'cdn.jsdelivr.net'].every(host => external.has(host)),
		`the check sees card images and scanner libraries load from third parties (seen: ${[...external].join(', ')})`);
	await visitor.goto(origin + '/datenschutz');
	const policyEn = await visitor.locator('main').innerText();
	await visitor.getByRole('button', { name: 'Deutsch', exact: true }).click();
	const policyDe = await visitor.locator('main').innerText();
	const unnamed = [...external].filter(host => !providers[host] || !policyEn.includes(providers[host]) || !policyDe.includes(providers[host]));
	check(unnamed.length === 0, `the privacy policy names every third party the browser contacts (missing: ${unnamed.join(', ')})`);
	check(['Cloudflare', 'STRATO', 'IONOS'].every(name => policyEn.includes(name) && policyDe.includes(name)),
		'the privacy policy names the server, mail and network providers');
	await privacy.close();
	console.log(`${checks} SEO checks passed. Screenshots: ${dir}`);
} finally {
	await browser?.close();
	const exited = once(server, 'exit');
	if (server.exitCode === null) { server.kill(); await exited; }
}
