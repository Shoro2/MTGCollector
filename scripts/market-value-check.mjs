// Build first. The detail page of the market value of every printing (/market-value) on a
// fresh synthetic database, never the application database: the homepage panel opens it, the
// chart is drawn, the filters change chart and table, the table works without JavaScript, and
// the page fits a phone.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { SCHEMA_SQL } from '../src/lib/server/schema-sql.ts';

const dir = resolve('data', `market-value-check-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const dbPath = resolve(dir, 'mtg.db');
const db = new Database(dbPath);
db.exec(SCHEMA_SQL);

const HORN = '11111111-1111-4111-8111-111111111111';
const BOLT = '22222222-2222-4222-8222-222222222222';
const token = randomBytes(32).toString('hex');
db.exec(`INSERT INTO users(id,google_id,email,name,currency) VALUES ('owner','owner','fixture@example.invalid','Fixture','USD');
	INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,image_uri,price_eur,price_usd,is_paper) VALUES
	('${HORN}','oracle-horn','War Horn','ori','Magic Origins','243','uncommon','Artifact','https://cards.scryfall.io/x.jpg',5,6,1),
	('${BOLT}','oracle-bolt','Lightning Bolt','tst','Test Set','1','common','Instant','https://cards.scryfall.io/y.jpg',3,NULL,1);`);
db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, 'owner', new Date(Date.now() + 86400000).toISOString());

// Price updates over about five months with a gap, relative to today so the named ranges have
// days in them. War Horn rises by 10 a month; Lightning Bolt gets its first (euro only) price
// 40 days ago, so it adds to the euro total without counting as a move.
const dayAt = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const snapshot = db.prepare("INSERT INTO price_history(card_id,language,snapshot_date,recorded_at,price_eur,price_usd) VALUES (?,'en',?,?,?,?)");
const offsets = [150, 140, 120, 100, 95, 60, 40, 20, 10, 5, 2, 1];
offsets.forEach((offset, i) => {
	const d = dayAt(offset);
	snapshot.run(HORN, d, `${d}T18:00:00Z`, 100 + i * 10, 200 + i * 5);
	if (offset === 40) snapshot.run(BOLT, d, `${d}T18:00:00Z`, 50, null);
});
const expectedMonths = new Set(offsets.map((o) => dayAt(o).slice(0, 7))).size;

const port = Number(process.env.MARKET_CHECK_PORT || 5198), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['build/index.js'], { windowsHide: true,
	env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, MTG_DB_PATH: dbPath, DISABLE_PRICE_UPDATES: '1' },
	stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', browser, checks = 0;
server.stdout.on('data', (data) => output += data); server.stderr.on('data', (data) => output += data);
function check(condition, label) { assert.ok(condition, label); checks++; console.log('PASS ' + label); }
try {
	for (let i = 0; i < 150; i++) {
		if (server.exitCode != null) throw new Error(output);
		try { if ((await fetch(origin + '/api/health')).ok) break; } catch {}
		await new Promise((r) => setTimeout(r, 200));
	}

	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
	const visitor = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await visitor.newPage(), errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|ERR_/.test(message.text())) errors.push(message.text()); });
	const fits = (target = page) => target.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
	// Non-transparent pixels the chart drew in the colour of its line.
	const amberPixels = (target = page) => target.evaluate(() => {
		const canvas = document.querySelector('[data-market-canvas]');
		const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
		let n = 0;
		for (let i = 0; i < data.length; i += 4) if (data[i] > 220 && data[i + 1] > 130 && data[i + 1] < 180 && data[i + 2] < 60 && data[i + 3] > 200) n++;
		return n;
	});
	const months = (target = page) => target.locator('[data-market-month]').count();
	const settled = async (target = page) => { await target.waitForLoadState('networkidle'); await target.waitForTimeout(400); };

	await page.goto(origin + '/');
	await page.locator('[data-market-panel] [data-market-chart]').click();
	await page.waitForURL('**/market-value');
	check(true, 'clicking the chart on the homepage opens the detail page');
	await settled();
	await page.goBack();
	await page.locator('[data-market-panel] h2').click();
	await page.waitForURL('**/market-value');
	check(true, 'the whole panel is the link, its heading too');
	await settled();

	check((await fetch(origin + '/market-value', { redirect: 'manual' })).status === 200, 'the page is public');
	check(await page.locator('link[rel="canonical"]').getAttribute('href') === 'https://mtg-collector.com/market-value' && await page.locator('meta[name="robots"]').count() === 0,
		'the page without filters is its own canonical and indexable');
	const title = await page.title(), description = await page.locator('meta[name="description"]').getAttribute('content');
	check(title.length <= 60 && description.length <= 155, 'title and description fit their snippet lengths');
	check(!/[-–—]/.test(await page.locator('main').innerText() + title + description), 'the copy uses no dashes');
	check(await amberPixels() > 50, 'the chart draws the market value');
	check(await page.locator('[data-market-range="all"]').getAttribute('aria-current') === 'true', 'all days are shown by default');
	check(await months() === expectedMonths, `the table has one row per month (${expectedMonths})`);
	check(await page.locator('[data-period-value]').innerText() === '€260', 'the latest value: War Horn €210 and Lightning Bolt €50');
	check(await page.locator('[data-period-change]').innerText() === '+€110', 'the change counts War Horn only, not the printing that got its first price');
	const monthChanges = await page.locator('[data-month-change]').evaluateAll((cells) => cells.map((c) => {
		const m = /([+−])€([\d,]+)/.exec(c.textContent);
		return m ? (m[1] === '+' ? 1 : -1) * Number(m[2].replace(/,/g, '')) : 0;
	}));
	check(monthChanges.reduce((a, b) => a + b, 0) === 110, `the months add up to the period's change (${monthChanges.join(', ')})`);
	check(await page.locator('[data-market-months] tbody tr').first().getAttribute('data-market-month') === dayAt(1).slice(0, 7), 'the newest month comes first');
	await page.screenshot({ path: resolve(dir, 'market-desktop.png'), fullPage: true });

	await page.locator('[data-market-range="30d"]').click();
	await page.waitForURL('**/market-value?range=30d');
	await settled();
	check(await page.locator('[data-period-change]').innerText() === '+€40', 'the 30 days filter changes the figures (five updates, four moves)');
	check(await months() <= 2 && await amberPixels() > 50, 'it changes the table and redraws the chart');
	check(await page.locator('meta[name="robots"]').getAttribute('content') === 'noindex, follow'
		&& await page.locator('link[rel="canonical"]').getAttribute('href') === 'https://mtg-collector.com/market-value?range=30d', 'a filtered page is noindex with its own canonical');

	await page.locator('[data-market-currency="USD"]').click();
	await page.waitForURL('**/market-value?range=30d&currency=USD');
	await settled();
	check(await page.locator('[data-market-page]').getAttribute('data-currency') === 'USD' && await page.locator('[data-period-value]').innerText() === '$255',
		'the TCGplayer sum in dollars, never converted, and the range stays');

	await page.locator('[data-market-view="change"]').click();
	await page.waitForURL('**view=change');
	await settled();
	check(await amberPixels() === 0 && await page.locator('[data-market-chart-panel] h2').innerText().then((t) => t.startsWith('Change per update')), 'the change view has its own chart');
	await page.locator('[data-market-view="printings"]').click();
	await page.waitForURL('**view=printings');
	await settled();
	check(await amberPixels() > 50, 'the printings view is drawn');
	await page.locator('[data-market-view="value"]').click();
	await settled();

	await page.locator('[data-market-currency="EUR"]').click();
	await settled();
	await page.locator('[data-market-dates] input[name="from"]').fill(dayAt(100));
	await page.locator('[data-market-dates] input[name="to"]').fill(dayAt(60));
	await page.locator('[data-market-dates] button').click();
	await page.waitForURL(`**/market-value?from=${dayAt(100)}&to=${dayAt(60)}`);
	await settled();
	check(await page.locator('[data-period-value]').innerText() === '€150' && await page.locator('[data-period-change]').innerText() === '+€20', 'the date filter shows only its days');
	check(await page.locator('[data-market-dates] input[name="from"]').inputValue() === dayAt(100) && await page.locator('[data-market-range][aria-current]').count() === 0,
		'the dates stay in their fields and no named range is marked');

	await page.goto(`${origin}/market-value?from=2000-01-01&to=2000-02-01`);
	check(await page.locator('[data-market-empty]').innerText() === 'No price update in this period.' && await months() === 0, 'an empty period says so');
	await page.goto(`${origin}/market-value?range=nonsense&view=pie&currency=GBP&from=soon`);
	check(await months() === expectedMonths, 'unknown filters fall back to the default');
	check(errors.length === 0, `no browser errors: ${errors.join('; ')}`);

	// The viewer's market: a signed-in user in dollars starts in dollars.
	const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	await owner.addCookies([{ name: 'session', value: token, url: origin }]);
	const signedIn = await owner.newPage();
	await signedIn.goto(origin + '/market-value');
	check(await signedIn.locator('[data-period-value]').innerText() === '$255', 'a user in dollars starts in dollars');
	check(await signedIn.locator('[data-market-currency="EUR"]').getAttribute('href') === '/market-value?currency=EUR', 'and can look at the other market');
	await owner.close();

	// Without JavaScript the filters and the table still work; only the chart needs it.
	const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
	const plain = await noScript.newPage();
	await plain.goto(origin + '/market-value?range=30d');
	check(await months(plain) <= 2 && await plain.locator('[data-period-change]').innerText() === '+€40', 'the table and figures work without JavaScript');
	await noScript.close();

	// Phones (owner rule 2026-10-29: no sideways scrolling, measured against clientWidth).
	const phone = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
	const small = await phone.newPage();
	await small.goto(origin + '/market-value');
	await settled(small);
	for (const [width, height] of [[320, 640], [360, 800], [390, 844], [430, 932], [568, 320], [915, 412]]) {
		await small.setViewportSize({ width, height });
		await small.waitForTimeout(250);
		check(await fits(small), `no sideways scrolling at ${width}×${height}`);
	}
	await small.setViewportSize({ width: 360, height: 800 });
	await small.waitForTimeout(400);
	const frame = await small.locator('[data-market-canvas]').boundingBox();
	check(frame.height > 200 && await amberPixels(small) > 50, `the chart is readable on a phone (${Math.round(frame.height)} px tall)`);
	await small.screenshot({ path: resolve(dir, 'market-mobile.png'), fullPage: true });
	await small.goto(origin + '/');
	await small.locator('[data-market-panel] [data-market-value]').tap();
	await small.waitForURL('**/market-value');
	check(true, 'tapping the panel on a phone opens the page');
	await phone.close();

	console.log(`PASS ${checks} market value checks. Screenshots: ${dir}`);
} finally { await browser?.close(); server.kill(); db.close(); }
