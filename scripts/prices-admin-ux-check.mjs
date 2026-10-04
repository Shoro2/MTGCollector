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
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'prices fit the mobile viewport');
	await page.screenshot({ path: resolve(dir, 'prices-mobile.png'), fullPage: true });
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
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'admin fits the mobile viewport');
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
