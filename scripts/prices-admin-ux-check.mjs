// Build first, then run: node scripts/prices-admin-ux-check.mjs
// Starts the real production server with an isolated, synthetic database.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { SCHEMA_SQL } from '../src/lib/server/schema-sql.ts';

const dir = resolve('data', `prices-admin-ux-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const dbPath = resolve(dir, 'mtg.db');
const db = new Database(dbPath);
db.exec(SCHEMA_SQL);
const token = randomBytes(32).toString('hex');
const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
db.prepare('INSERT INTO users(id,google_id,email,name,created_at) VALUES (?,?,?,?,?)').run('fixture-owner', 'fixture-google', 'fixture@example.invalid', 'Fixture Owner', day(-10));
db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, 'fixture-owner', new Date(Date.now() + 86400000).toISOString());
db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('expired-fixture', 'fixture-owner', new Date(Date.now() - 3600000).toISOString());
const fixtures = [
	['usd', 'Dollar Card', null, 10, 5, 2, 'en'],
	['de', 'German Holding', 5, null, 3, 1, 'de'],
	['no-cost', 'Missing Cost', 20, null, null, 3, 'en'],
	['no-market', 'Missing Market', null, null, 50, 2, 'en'],
	['free', 'Free Copy', 9, null, 0, 1, 'en']
];
for (const [id, name, eur, usd, cost, quantity, lang] of fixtures) {
	db.prepare(`INSERT INTO cards(id,name,set_code,set_name,collector_number,price_eur,price_usd) VALUES (?,?, 'tst','Test Set','1',?,?)`).run(id, name, eur, usd);
	db.prepare('INSERT INTO collection_cards(card_id,user_id,quantity,language,purchase_price,added_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'fixture-owner', quantity, lang, cost, day(-3));
	if (eur != null || usd != null) db.prepare(`INSERT INTO price_history(card_id,language,snapshot_date,recorded_at,price_eur,price_usd) VALUES (?,'en',?,?,?,?)`)
		.run(id, day(-2), day(-2) + 'T05:00:00Z', eur, usd);
}
db.prepare(`INSERT INTO collection_cards(card_id,user_id,quantity,language,purchase_price,added_at) VALUES ('usd','fixture-owner',1,'en',4,?)`).run(day(-1));
db.close();

const port = Number(process.env.PRICES_UX_PORT || 5190);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['build/index.js'], {
	env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, MTG_DB_PATH: dbPath,
		DISABLE_PRICE_UPDATES: '1', ADMIN_EMAIL: 'fixture@example.invalid' }, windowsHide: true,
	stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
let browser;
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; console.log(`PASS ${message}`); }
try {
	for (let i = 0; i < 150; i++) {
		if (server.exitCode != null) throw new Error(output);
		try { if ((await fetch(origin + '/api/health')).ok) break; } catch {}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, headless: true });
	const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await context.addCookies([{ name: 'session', value: token, url: origin }]);
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.route('**/api/prices/data', async route => {
		await route.fulfill({ status: 503, json: { error: 'fixture retry' } });
	}, { times: 1 });
	await page.goto(origin + '/prices');
	await page.getByText('Failed to load price data (HTTP 503).').waitFor();
	check(await page.locator('.kpi-value').count() === 0, 'failed load does not display zero-valued statistics');
	const response = page.waitForResponse(r => r.url().endsWith('/api/prices/data') && r.status() === 200);
	await page.getByRole('button', { name: 'Retry', exact: true }).click();
	const loaded = await response;
	const data = await loaded.json();
	check(loaded.headers()['cache-control'].includes('no-store'), 'browser cache cannot hide collection changes');
	check(data.stats.uniqueCards === 5 && data.stats.totalCards === 10, 'distinct printings and quantities are separate');
	check(data.missingPriceCount === 3 && data.missingMarketCount === 2, 'warnings count copies');
	check(data.profitHistory.at(-1).total_value === data.stats.profitValue && data.profitHistory.at(-1).total_purchase === data.stats.profitCost, 'today and comparable KPIs agree');
	await page.getByText('3 copies have no purchase price.').waitFor();
	await page.getByText('2 copies have no market price', { exact: false }).waitFor();
	await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some(canvas => {
		const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
		return pixels.some((v, i) => i % 4 === 3 && v > 0);
	}));
	check(true, 'retry renders the actual Chart.js chart');
	const dollarRow = page.locator('a', { has: page.getByText('Dollar Card', { exact: true }) }).first();
	check((await dollarRow.innerText()).includes('€'), 'USD-only holding displays a converted euro value');
	check(await page.getByText('Unique Printings', { exact: true }).isVisible(), 'unique count is labelled as printings');
	check(await page.getByText('English reference', { exact: true }).count() > 0, 'reference prices are labelled on foreign cards');
	check(await page.getByText('market value compared with', { exact: false }).isVisible(), 'profit states the matching market value and purchase cost');
	check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'prices fit the mobile viewport');
	await page.screenshot({ path: resolve(dir, 'prices-mobile.png'), fullPage: true });
	// Until 2026-10-30 the chart kept a 2:1 box: on a phone the legend and the
	// date labels took its whole height and the plot collapsed into one line.
	// Count the horizontal grid lines Chart.js draws across the plot area.
	for (const width of [320, 360, 390]) {
		await page.setViewportSize({ width, height: 800 });
		await page.waitForTimeout(400);
		const plot = await page.evaluate(() => {
			const canvas = document.querySelector('.chart-frame canvas') ?? document.querySelector('canvas');
			if (!canvas) return null;
			const { data, width: w, height: h } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
			const scale = canvas.width / canvas.getBoundingClientRect().width;
			const grid = [51, 65, 85];
			const rows = [];
			for (let y = 0; y < h; y++) {
				let run = 0;
				for (let x = 0; x < w; x++) {
					const i = (y * w + x) * 4;
					if (data[i + 3] > 200 && grid.every((c, k) => Math.abs(data[i + k] - c) < 12)) run++;
				}
				if (run > w * 0.4) rows.push(y);
			}
			const lines = rows.filter((y, i) => i === 0 || y - rows[i - 1] > 1);
			return { height: canvas.getBoundingClientRect().height, lines: lines.length, span: lines.length ? (lines.at(-1) - lines[0]) / scale : 0 };
		});
		check(plot && plot.height >= 240, `profit chart is ${plot?.height} px tall at ${width} px`);
		check(plot.lines >= 3 && plot.span >= 120, `profit chart plot area spans ${Math.round(plot.span)} px with ${plot.lines} grid lines at ${width} px`);
	}
	await page.setViewportSize({ width: 360, height: 800 });
	await page.locator('.chart-frame').scrollIntoViewIfNeeded();
	await page.locator('.chart-frame').screenshot({ path: resolve(dir, 'prices-chart-360.png') });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole('button', { name: 'Profit', exact: true }).click();
	const freeRow = page.locator('a', { has: page.getByText('Free Copy', { exact: true }) });
	check((await freeRow.innerText()).includes('+€9.00'), 'zero purchase price still shows the absolute profit');

	await page.route('**/api/prices/card?**', async route => {
		await route.fulfill({ status: 500, json: { error: 'fixture error' } });
	}, { times: 1 });
	await page.getByRole('button', { name: 'Price history', exact: true }).first().click();
	await page.getByRole('alert').filter({ hasText: 'HTTP 500' }).waitFor();
	check(true, 'card chart failures produce an error instead of permanent loading');
	await page.getByRole('button', { name: 'Close price history' }).click();
	const germanRow = page.locator('div.flex.items-center', { has: page.locator('a', { has: page.getByText('German Holding', { exact: true }) }) }).last();
	const cardResponse = page.waitForResponse(r => r.url().includes('/api/prices/card?id=de'));
	await germanRow.getByRole('button', { name: 'Price history', exact: true }).click();
	const cardData = await (await cardResponse).json();
	check(cardData.fallbackUsed && cardData.history[0].recorded_at === day(-2), 'card history marks English fallback and preserves the UTC snapshot day');
	await page.getByText('Includes English reference prices', { exact: false }).waitFor();
	await page.getByRole('button', { name: 'Close price history' }).click();

	// Display size (/settings, src/lib/ui-scale.ts; owner report 2026-10-30: the
	// prices page looked small on a large monitor). Everything is in rem, so the
	// root font size scales text, images and the page width together.
	const rootPx = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
	const mainWidth = () => page.evaluate(() => document.querySelector('main').getBoundingClientRect().width);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(origin + '/prices');
	await page.locator('.kpi-value').first().waitFor();
	check(await page.evaluate(() => document.documentElement.dataset.uiScale) === 'auto', 'without a cookie the server renders the automatic size');
	check(await rootPx() === 16, 'automatic keeps the normal size in a 1440 px window');
	check(Math.round(await mainWidth()) === 1320, 'the page is 1320 px wide at the normal size');
	await page.setViewportSize({ width: 2560, height: 1440 });
	await page.waitForTimeout(400);
	check(Math.abs(await rootPx() - 19.2) < 0.05, `automatic grows to 120 % in a 2560 px window (${await rootPx()} px)`);
	check(Math.round(await mainWidth()) === 1584, `the page grows with it (${Math.round(await mainWidth())} px)`);
	const chartHeight = await page.evaluate(() => document.querySelector('.chart-frame').getBoundingClientRect().height);
	check(chartHeight <= 1440 * 0.7 + 1, `the profit chart stays within 70 % of the window (${Math.round(chartHeight)} px)`);
	const topRows = await page.evaluate(() => [...document.querySelectorAll('a[href^="/collection?edit="]')].map(a => Math.round(a.getBoundingClientRect().left)));
	check(topRows.length === 5 && topRows[3] > topRows[0] && topRows[0] === topRows[2], 'top cards run down two columns on a wide screen');
	await page.screenshot({ path: resolve(dir, 'prices-2560-auto.png') });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(origin + '/settings');
	const sizes = page.locator('[data-ui-scale-setting]');
	check(await sizes.getByRole('button', { name: 'Automatic' }).getAttribute('aria-pressed') === 'true', 'settings show automatic as the current size');
	await sizes.getByRole('button', { name: '125 %' }).click();
	check(await rootPx() === 20 && await page.evaluate(() => document.documentElement.dataset.uiScale) === '125', 'choosing 125 % applies at once');
	check(await page.locator('[data-ui-scale-effective]').innerText() === 'Now: 125 %.', 'the panel states the size in use');
	const cookie = (await context.cookies()).find(c => c.name === 'mtg_ui_scale');
	check(cookie?.value === '125' && cookie.expires > Date.now() / 1000 + 300 * 86400, 'the size is stored in a cookie for a year');
	const html = await (await context.request.get(origin + '/prices')).text();
	check(html.includes('<html lang="en" data-ui-scale="125">'), 'the server renders the stored size into the first paint');
	await page.goto(origin + '/prices');
	await page.locator('.kpi-value').first().waitFor();
	check(Math.round(await mainWidth()) === 1440, `125 % widens the page up to the window (${Math.round(await mainWidth())} px)`);
	check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'prices at 125 % do not scroll sideways in a 1440 px window');
	await page.waitForFunction(() => document.querySelector('.chart-frame canvas'));
	await page.screenshot({ path: resolve(dir, 'prices-1440-125.png') });
	await context.addCookies([{ name: 'mtg_ui_scale', value: '150', url: origin }]);
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 800 });
		await page.goto(origin + '/prices');
		await page.locator('.kpi-value').first().waitFor();
		check(await rootPx() === 16, `150 % keeps the normal size on a ${width} px phone`);
		check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `prices fit ${width} px with 150 % chosen`);
	}
	await context.addCookies([{ name: 'mtg_ui_scale', value: '90', url: origin }]);
	await page.reload();
	check(await rootPx() === 14.4, '90 % also shrinks a phone');
	await context.addCookies([{ name: 'mtg_ui_scale', value: 'bogus"><b>', url: origin }]);
	check((await (await context.request.get(origin + '/prices')).text()).includes('data-ui-scale="auto"'), 'an unknown cookie value renders as automatic');
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(origin + '/settings');
	await page.locator('[data-ui-scale-setting]').getByRole('button', { name: 'Automatic' }).click();
	check(!(await context.cookies()).some(c => c.name === 'mtg_ui_scale'), 'choosing automatic deletes the cookie');
	await page.setViewportSize({ width: 390, height: 844 });

	// Insert after boot so initDb's cleanup cannot mask the admin comparison.
	const fixture = new Database(dbPath);
	fixture.prepare('INSERT INTO sessions VALUES (?,?,?)').run('expired-after-boot', 'fixture-owner', new Date(Date.now() - 1000).toISOString());
	fixture.close();
	await page.goto(origin + '/admin');
	await page.getByRole('heading', { name: 'Admin Dashboard' }).waitFor();
	check(await page.getByText('1 active session', { exact: true }).isVisible(), 'admin counts only unexpired ISO sessions');
	check(await page.getByText('Catalogue Printings', { exact: true }).isVisible(), 'admin catalogue count has an unambiguous label');
	check(await page.getByText('New or changed prices only', { exact: false }).isVisible(), 'snapshot counts explain change-only updates');
	const sessionsCount = page.locator('tr', { has: page.getByRole('cell', { name: 'sessions', exact: true }) }).getByRole('cell').nth(1);
	check(await sessionsCount.innerText() === '2', 'expired sessions remain visible in the raw table count');
	await page.getByRole('button', { name: 'Cleanup Expired Sessions' }).click();
	await page.getByText('Cleaned up 1 expired sessions', { exact: true }).waitFor();
	await page.waitForFunction(() => [...document.querySelectorAll('tr')].some(row => row.cells[0]?.textContent === 'sessions' && row.cells[1]?.textContent === '1'));
	check(true, 'session cleanup refreshes the displayed counts');
	check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'admin fits the mobile viewport');
	await page.screenshot({ path: resolve(dir, 'admin-mobile.png'), fullPage: true });

	await page.route('**/api/prices/data', route => route.fulfill({ json: { ...data, missingPriceCount: 10,
		profitHistory: [], stats: { ...data.stats, totalPurchaseValue: 0, profitCopies: 0, profitValue: 0, profitCost: 0 } } }), { times: 1 });
	await page.goto(origin + '/prices');
	await page.getByText('Add purchase prices to see profit and loss.').waitFor();
	check(await page.getByText('10 copies have no purchase price.').isVisible(), 'missing purchase prices are explained even when the chart is empty');

	const missing = data.topCards.find(row => row.id === 'no-cost');
	const changed = await context.request.put(origin + '/collection', { data: {
		id: missing.collection_id, quantity: 3, condition: 'near_mint', foil: false, language: 'en', purchasePrice: 1
	} });
	check(changed.ok(), 'a real collection edit succeeds in the isolated fixture');
	const updatedResponse = page.waitForResponse(r => r.url().endsWith('/api/prices/data') && r.status() === 200);
	await page.reload();
	const updated = await (await updatedResponse).json();
	check(updated.missingPriceCount === 0 && updated.stats.profitCopies === 8, 'returning to prices sees the edit immediately');
	check(errors.length === 0, `no browser errors: ${errors.join('; ')}`);
	console.log(JSON.stringify({ checks, fixtureDirectory: dir }));
} finally {
	await browser?.close();
	server.kill();
}
