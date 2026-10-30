// Build first. The display currency (/settings) end to end on a fresh synthetic database,
// never the application database: migration 0032 on an old database, switching to US
// dollars, every page that shows prices, purchase prices in their own currency, and
// visitors and search snippets staying in euros.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { SCHEMA_SQL } from '../src/lib/server/schema-sql.ts';

const dir = resolve('data', `currency-check-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const dbPath = resolve(dir, 'mtg.db');
const db = new Database(dbPath);
// An existing database from before the currency columns.
const legacySchema = SCHEMA_SQL
	.replace(/,\r?\n\tcurrency TEXT NOT NULL DEFAULT 'EUR'/, '')
	.replace(/,\r?\n\tpurchase_currency TEXT NOT NULL DEFAULT 'EUR'/, '');
assert.notEqual(legacySchema, SCHEMA_SQL, 'the legacy schema simulation must remove the currency columns');
db.exec(legacySchema);
assert.ok(!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'currency'), 'the simulated old database has no users.currency');

const HORN = '11111111-1111-4111-8111-111111111111';
const BOLT = '22222222-2222-4222-8222-222222222222';
const token = randomBytes(32).toString('hex');
db.exec(`INSERT INTO users(id,google_id,email,name) VALUES ('owner','owner','fixture@example.invalid','Fixture');
	INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,image_uri,price_eur,price_usd,is_paper) VALUES
	('${HORN}','oracle-horn','War Horn','ori','Magic Origins','243','uncommon','Artifact','https://cards.scryfall.io/x.jpg',5,6,1),
	('${BOLT}','oracle-bolt','Lightning Bolt','tst','Test Set','1','common','Instant','https://cards.scryfall.io/y.jpg',3,NULL,1);
	INSERT INTO collection_cards(id,user_id,card_id,quantity,condition,language,foil,purchase_price,added_at) VALUES
	(1,'owner','${HORN}',2,'near_mint','en',0,2,'2026-01-01T00:00:00.000Z');`);
db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, 'owner', new Date(Date.now() + 86400000).toISOString());

const port = Number(process.env.CURRENCY_CHECK_PORT || 5197), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['build/index.js'], { windowsHide: true,
	env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, MTG_DB_PATH: dbPath, DISABLE_PRICE_UPDATES: '1' },
	stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', browser, checks = 0;
server.stdout.on('data', (data) => output += data); server.stderr.on('data', (data) => output += data);
function check(condition, label) { assert.ok(condition, label); checks++; console.log('PASS ' + label); }
const money = (symbol, n) => `${symbol}${n.toFixed(2)}`;
try {
	for (let i = 0; i < 150; i++) {
		if (server.exitCode != null) throw new Error(output);
		try { if ((await fetch(origin + '/api/health')).ok) break; } catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	check(db.prepare("SELECT currency FROM users WHERE id='owner'").get().currency === 'EUR', 'migration gives existing accounts euros');
	check(db.prepare('SELECT purchase_currency FROM collection_cards WHERE id=1').get().purchase_currency === 'EUR', 'migration keeps existing purchase prices in euros');

	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
	const context = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });
	await context.addCookies([{ name: 'session', value: token, url: origin }]);
	const page = await context.newPage(), errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

	const rate = (await (await context.request.get(origin + '/api/prices/data')).json()).usdToEur;
	check(rate > 0, `the exchange rate is known (${rate})`);

	await page.goto(origin + '/collection');
	check(await page.locator('.kpi-card', { hasText: 'Total Value' }).locator('.kpi-value').innerText() === '€10.00', 'euros by default: Cardmarket value of the collection');

	await page.goto(origin + '/settings', { waitUntil: 'networkidle' });
	const panel = page.locator('[data-settings="currency"]');
	check(await panel.getByRole('radio', { name: /Euro/ }).isChecked(), 'settings show euros as the current choice');
	check(await fits(), 'settings fit a 360 px phone');
	await page.screenshot({ path: resolve(dir, 'settings-mobile.png'), fullPage: true });
	await panel.getByRole('radio', { name: /US dollar/ }).check();
	await panel.getByRole('status').filter({ hasText: 'Prices are now shown in US dollars.' }).waitFor();
	check(db.prepare("SELECT currency FROM users WHERE id='owner'").get().currency === 'USD', 'the choice is stored in the account');
	check(await panel.getByRole('radio', { name: /US dollar/ }).isChecked(), 'settings show dollars after the switch');
	const refused = await context.request.patch(origin + '/api/settings', { data: { currency: 'GBP' } });
	check(refused.status() === 400 && db.prepare("SELECT currency FROM users WHERE id='owner'").get().currency === 'USD', 'an unknown currency is refused');
	const anonymous = await fetch(origin + '/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json', origin }, body: '{"currency":"USD"}' });
	check(anonymous.status === 401, 'visitors cannot change the setting');

	// The War Horn has its own dollar price ($6); the euro purchase price (€2) is converted.
	await page.goto(origin + '/collection');
	check(await page.locator('.kpi-card', { hasText: 'Total Value' }).locator('.kpi-value').innerText() === '$12.00', 'collection value in TCGplayer dollars');
	check(await fits(), 'collection in dollars fits a 360 px phone');
	const data = await (await context.request.get(origin + '/api/prices/data')).json();
	check(data.currency === 'USD' && data.stats.totalValue === 12 && Math.abs(data.stats.totalPurchaseValue - 4 / rate) < 1e-9,
		'prices API: dollar value, euro cost converted at the rate');

	// A purchase price entered in dollars stays in dollars.
	const edited = await context.request.put(origin + '/collection', { data: { id: 1, quantity: 2, condition: 'near_mint', language: 'en', purchasePrice: 2.5, purchaseCurrency: 'USD' } });
	check(edited.ok() && JSON.stringify(db.prepare('SELECT purchase_price, purchase_currency FROM collection_cards WHERE id=1').get()) === '{"purchase_price":2.5,"purchase_currency":"USD"}',
		'an edited purchase price keeps the currency it was entered in');
	const after = await (await context.request.get(origin + '/api/prices/data')).json();
	check(after.stats.totalPurchaseValue === 5 && after.stats.profitValue === 12, 'a dollar cost is counted unconverted in dollar mode');
	const added = await context.request.post(origin + '/collection', { data: { cardId: BOLT, quantity: 1, purchasePrice: 1 } });
	check(added.ok() && db.prepare("SELECT purchase_currency FROM collection_cards WHERE card_id=?").get(BOLT).purchase_currency === 'USD',
		'a new purchase price defaults to the display currency');

	await page.goto(origin + '/');
	check(await page.locator('.kpi-value', { hasText: '$' }).count() > 0 && await page.locator('.kpi-value', { hasText: '€' }).count() === 0, 'homepage dashboard in dollars');
	await page.goto(origin + '/prices');
	await page.locator('.kpi-value', { hasText: '$' }).first().waitFor();
	check(await page.locator('.kpi-value', { hasText: '€' }).count() === 0, 'prices page in dollars');
	check(await fits(), 'prices page in dollars fits a 360 px phone');
	await page.screenshot({ path: resolve(dir, 'prices-usd-mobile.png'), fullPage: true });

	// Lightning Bolt has no TCGplayer price: its Cardmarket price keeps the euro sign, never converted.
	await page.goto(origin + `/cards/${BOLT}`);
	check((await page.locator('main').innerText()).includes('€3.00'), 'a printing without a dollar price shows its euro price as euros');
	await page.goto(origin + `/cards/${HORN}`);
	check((await page.locator('main').innerText()).includes('$6.00'), 'a printing page shows the dollar price');
	await page.goto(origin + '/cards/war-horn');
	check(/from\s+\$6\.00/.test(await page.locator('main').innerText()), 'card page: lowest price in dollars');
	check((await page.title()).includes('€5.00'), 'the search snippet stays in euros');

	const deck = await (await context.request.post(origin + '/api/decks', { data: { name: 'Currency deck', format: 'casual', visibility: 'private', list: '2 War Horn\n1 Lightning Bolt' } })).json();
	check(typeof deck.id === 'string', 'a deck is created');
	await page.goto(origin + `/decks/${deck.id}`);
	// 2 × $6 + €3 converted.
	check(await page.locator('[data-kpi="value"]').innerText() === money('$', 12 + 3 / rate), 'deck value in dollars, the euro-only card converted');
	await page.goto(origin + '/decks');
	check((await page.locator('main').innerText()).includes(money('$', 12 + 3 / rate)), 'deck list value in dollars');

	// Visitors always see euros.
	const visitor = await browser.newPage();
	await visitor.goto(origin + '/cards/war-horn');
	check(/from\s+€5\.00/.test(await visitor.locator('main').innerText()), 'visitors see euros');
	await visitor.close();

	await page.goto(origin + '/settings', { waitUntil: 'networkidle' });
	await page.locator('[data-settings="currency"]').getByRole('radio', { name: /Euro/ }).check();
	await page.locator('[data-settings="currency"]').getByRole('status').filter({ hasText: 'euros' }).waitFor();
	const back = await (await context.request.get(origin + '/api/prices/data')).json();
	check(back.currency === 'EUR' && back.stats.totalValue === 13 && Math.abs(back.stats.totalPurchaseValue - (2 * 2.5 * rate + rate)) < 1e-9,
		'back in euros: dollar costs converted, cache refreshed');
	check(errors.length === 0, `no browser errors: ${errors.join('; ')}`);
	console.log(`PASS ${checks} currency checks. Screenshots: ${dir}`);
} finally { await browser?.close(); server.kill(); db.close(); }
