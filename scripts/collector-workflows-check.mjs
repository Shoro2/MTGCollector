// Build first. All writes target a fresh synthetic database, never the application database.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { SCHEMA_SQL } from '../src/lib/server/schema-sql.ts';

const dir = resolve('data', `collector-workflows-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const dbPath = resolve(dir, 'mtg.db');
const db = new Database(dbPath);
// Simulate an existing database without the newer location and proxy columns.
const legacySchema = SCHEMA_SQL.replace(/\tadded_at TEXT,\r?\n\tlocation TEXT NOT NULL DEFAULT '',\r?\n\tproxy INTEGER NOT NULL DEFAULT 0/, '\tadded_at TEXT');
assert.notEqual(legacySchema, SCHEMA_SQL, 'the legacy schema simulation must remove location and proxy');
db.exec(legacySchema);
const legacyColumns = db.prepare('PRAGMA table_info(collection_cards)').all().map(column => column.name);
assert.ok(!legacyColumns.includes('location') && !legacyColumns.includes('proxy'), 'the simulated old database lacks location and proxy');
const token = randomBytes(32).toString('hex');
db.exec(`INSERT INTO users(id,google_id,email,name) VALUES ('owner','owner','fixture@example.invalid','Fixture'),('other','other','other@example.invalid','Other');
	INSERT INTO cards(id,name,set_code,set_name,collector_number,price_eur) VALUES ('horn','War Horn','ori','Magic Origins','243',5),
	('horn-p','War Horn','ori','Magic Origins','243p',6),('bolt','Lightning Bolt','tst','Test Set','1',3);
	INSERT INTO collection_cards(id,user_id,card_id,quantity,condition,language,foil,purchase_price,notes,added_at) VALUES
	(1,'owner','horn',4,'near_mint','en',0,2,'Original notes','2026-01-01T00:00:00.000Z'),
	(2,'other','horn',9,'near_mint','en',0,3,NULL,'2026-01-01T00:00:00.000Z');
	INSERT INTO tags(id,user_id,name) VALUES (1,'owner','Red; Blue'); INSERT INTO collection_card_tags VALUES(1,1);`);
db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, 'owner', new Date(Date.now() + 86400000).toISOString());
const port = Number(process.env.COLLECTOR_UX_PORT || 5193), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['build/index.js'], { windowsHide: true,
	env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, MTG_DB_PATH: dbPath, DISABLE_PRICE_UPDATES: '1', BODY_SIZE_LIMIT: '12M' },
	stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', browser, checks = 0;
server.stdout.on('data', data => output += data); server.stderr.on('data', data => output += data);
function check(condition, label) { assert.ok(condition, label); checks++; console.log('PASS ' + label); }
try {
	for (let i = 0; i < 150; i++) {
		if (server.exitCode != null) throw new Error(output);
		try { if ((await fetch(origin + '/api/health')).ok) break; } catch {}
		await new Promise(r => setTimeout(r, 200));
	}
	check(db.prepare('SELECT location FROM collection_cards WHERE id=1').get().location === '', 'migration keeps existing entries unassigned');
	check(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_collection_user_location'").get(), 'location index is installed');
	check(db.prepare('SELECT proxy FROM collection_cards WHERE id=1').get().proxy === 0, 'migration keeps existing entries real cards');
	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	await context.addCookies([{ name: 'session', value: token, url: origin }]);
	const page = await context.newPage(), errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(origin + '/collection');
	check(await page.locator('nav.app-nav a[href="/portfolio-tracker"]').count() === 0, 'signed-in users get no Portfolio menu item');
	await page.getByRole('button', { name: 'Select this page', exact: true }).click();
	await page.getByLabel('Change location (empty clears it)').check();
	await page.getByLabel('New location', { exact: true }).fill('Box A');
	await page.getByRole('button', { name: 'Apply to selected entries', exact: true }).click();
	await page.getByText('Box A', { exact: true }).last().waitFor();
	check(db.prepare('SELECT location FROM collection_cards WHERE id=1').get().location === 'Box A', 'bulk edit persists the location');
	check(db.prepare('SELECT location FROM collection_cards WHERE id=2').get().location === '', 'bulk edit leaves other accounts unchanged');
	await page.getByText('War Horn', { exact: true }).first().click();
	await page.getByText('Move some copies to another location', { exact: true }).click();
	await page.getByLabel('Copies', { exact: true }).fill('2');
	await page.getByLabel('Destination', { exact: true }).fill('Box B');
	await page.getByRole('button', { name: 'Move copies', exact: true }).click();
	await page.getByText('Box B', { exact: true }).last().waitFor();
	const owned = db.prepare("SELECT quantity,location,purchase_price,added_at FROM collection_cards WHERE user_id='owner' ORDER BY location").all();
	check(owned.length === 2 && owned.every(r => r.quantity === 2 && r.purchase_price === 2 && r.added_at === '2026-01-01T00:00:00.000Z'), 'partial move preserves total quantity, cost and date');
	check(db.prepare('SELECT COUNT(*) AS n FROM collection_card_tags').get().n === 2, 'partial move copies tag assignments');
	await page.getByLabel('Location', { exact: true }).selectOption('location:Box B');
	await page.waitForURL('**/collection?location=Box+B');
	check(await page.getByRole('checkbox', { name: 'Select War Horn' }).count() === 1, 'location filter finds only the matching entry');
	await page.screenshot({ path: resolve(dir, 'collection-mobile.png'), fullPage: true });
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'collection fits mobile width');
	await page.getByText('War Horn', { exact: true }).first().click();
	await page.getByLabel('Proxy (not counted in value)', { exact: true }).check();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.getByText('PROXY', { exact: true }).waitFor();
	check(db.prepare("SELECT proxy FROM collection_cards WHERE user_id='owner' AND location='Box B'").get().proxy === 1, 'edit dialog marks an entry as proxy');
	check(db.prepare("SELECT proxy FROM collection_cards WHERE user_id='owner' AND location='Box A'").get().proxy === 0, 'other entries stay real cards');
	const marked = db.prepare("SELECT quantity,location,purchase_price,added_at,proxy FROM collection_cards WHERE user_id='owner' AND card_id='horn' ORDER BY location").all();
	await page.goto(origin + '/collection');
	check(await page.locator('.kpi-card', { hasText: 'Total Value' }).locator('.kpi-value').innerText() === '€10.00', 'collection value leaves proxies out');
	check((await page.locator('.kpi-card', { hasText: 'Total Cards' }).innerText()).includes('incl. 2 proxies'), 'card count includes proxies');
	const priceData = await (await context.request.get(origin + '/api/prices/data')).json();
	check(priceData.stats.totalValue === 10 && priceData.stats.totalCards === 4 && priceData.proxyCopies === 2, 'price statistics count proxies as cards, not as value');
	await page.getByLabel('Proxy filter', { exact: true }).selectOption('only');
	await page.waitForURL('**/collection?proxy=only');
	check(await page.getByRole('checkbox', { name: 'Select War Horn' }).count() === 1, 'proxy filter shows only proxies');
	await page.screenshot({ path: resolve(dir, 'collection-proxies-mobile.png'), fullPage: true });
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'collection with proxies fits mobile width');
	const moxfieldRows = (await (await context.request.get(origin + '/collection/export?format=csv')).text()).split('\n');
	check(moxfieldRows.some(row => row.startsWith('"2","0","War Horn"') && row.includes('"False","True"')) &&
		moxfieldRows.some(row => row.startsWith('"2","2","War Horn"') && row.includes('"False","False"')), 'Moxfield export marks proxies and keeps them off the tradelist');
	await page.goto(origin + '/');
	check(await page.locator('.kpi-value', { hasText: '€10.00' }).count() === 1, 'homepage value leaves proxies out');
	check((await page.getByRole('heading', { level: 1 }).innerText()).startsWith('Welcome back, Fixture'), 'signed in, the homepage is the dashboard');
	check((await page.locator('.kpi-card', { hasText: 'Cards' }).first().innerText()).includes('2 of them proxies'), 'dashboard counts proxies as cards');
	check((await page.locator('.kpi-card', { hasText: 'Profit / loss' }).innerText()).includes('+€6.00') &&
		(await page.locator('.kpi-card', { hasText: 'Profit / loss' }).innerText()).includes('+150.0% on what you paid'), 'dashboard profit matches the prices page');
	const recent = page.locator('section[aria-labelledby="recently-added"]');
	check(await recent.locator('a', { hasText: 'Proxy, Box B' }).filter({ hasText: 'not valued' }).count() === 1 &&
		await recent.locator('a', { hasText: 'Box A' }).filter({ hasText: '€5.00' }).count() === 1, 'recently added shows locations, prices and unvalued proxies');
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'dashboard fits mobile width');
	await page.screenshot({ path: resolve(dir, 'home-dashboard-mobile.png'), fullPage: true });
	await page.goto(origin + '/collection');
	const forbidden = await context.request.post(origin + '/collection/bulk', { data: { action: 'edit', ids: [1, 2], changes: { location: 'Wrong' } } });
	check(forbidden.status() === 400 && db.prepare('SELECT location FROM collection_cards WHERE id=1').get().location === 'Box A', 'mixed-owner request fails atomically');
	const largeCsv = 'Name,Set Code,Collector Number,Notes\n' + Array.from({ length: 90 }, () => 'War Horn,ori,243,' + 'x'.repeat(8000)).join('\n');
	const largePreview = await context.request.post(origin + '/collection/import', { headers: { Origin: origin }, multipart: {
		action: 'preview', mode: 'append', file: { name: 'large.csv', mimeType: 'text/csv', buffer: Buffer.from(largeCsv) }
	} });
	check(largePreview.ok() && (await largePreview.json()).summary.ready === 90, 'configured production limit accepts CSV files above 512 KB');

	await page.getByRole('button', { name: 'Import', exact: true }).click();
	const csv = 'Name,Set Code,Collector Number,Quantity,Language,Purchase Price,Purchase Price Currency,Binder Name\nLightning Bolt,tst,1,3,English,0,EUR,Trades';
	await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name: 'manabox.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
	await page.getByRole('button', { name: 'Preview import', exact: true }).click();
	await page.getByText('1 entries ready · 3 copies · 0 unresolved rows', { exact: true }).waitFor();
	check(db.prepare("SELECT COUNT(*) AS n FROM collection_cards WHERE user_id='owner'").get().n === 2, 'preview does not write collection rows');
	await page.getByText('Review column mapping', { exact: true }).click();
	await page.screenshot({ path: resolve(dir, 'import-mobile.png'), fullPage: true });
	check(await page.locator('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'import dialog fits mobile width');
	await page.getByRole('button', { name: 'Import 3 copies', exact: true }).click();
	await page.getByRole('status').filter({ hasText: 'Imported 3 copies' }).waitFor();
	check(db.prepare("SELECT quantity,location,purchase_price FROM collection_cards WHERE card_id='bolt' AND user_id='owner'").get().purchase_price === 0, 'CSV confirmation imports actual zero purchase price');
	await page.getByRole('button', { name: 'Close import', exact: true }).click();
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const download = page.getByRole('link', { name: 'Download collection CSV', exact: true });
	await download.waitFor();
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'export choices fit mobile width');
	await download.focus(); await page.keyboard.press('Escape');
	const backup = await (await context.request.get(origin + '/collection/export?format=collector')).body();
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name: 'mtg-collector.csv', mimeType: 'text/csv', buffer: backup });
	await page.getByLabel('Import mode', { exact: true }).selectOption('sync');
	await page.getByRole('button', { name: 'Preview import', exact: true }).click();
	await page.getByText('3 entries ready · 7 copies · 0 unresolved rows', { exact: true }).waitFor();
	check(await page.getByRole('button', { name: 'Import 7 copies', exact: true }).isDisabled(), 'replacement requires explicit confirmation');
	await page.getByRole('checkbox', { name: /Replace all 7 existing copies/ }).check();
	await page.getByRole('button', { name: 'Import 7 copies', exact: true }).click();
	await page.getByRole('status').filter({ hasText: 'Imported 7 copies' }).waitFor();
	const restored = db.prepare("SELECT quantity,location,purchase_price,added_at,proxy FROM collection_cards WHERE user_id='owner' AND card_id='horn' ORDER BY location").all();
	check(JSON.stringify(restored) === JSON.stringify(marked), 'full export and re-import preserve split holdings and proxies');
	check(db.prepare("SELECT COUNT(*) AS n FROM collection_card_tags cct JOIN tags t ON cct.tag_id=t.id WHERE t.name='Red; Blue'").get().n === 2, 'full export preserves tags containing delimiters');
	await page.getByRole('button', { name: 'Close import', exact: true }).click();

	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByLabel('File format', { exact: true }).selectOption('text');
	await page.getByLabel('Card list', { exact: true }).fill('1 Lightning Bolt (TST) 1\n2 War Horn (ORI) 243p');
	await page.getByLabel('Import every card as a proxy', { exact: true }).check();
	await page.getByLabel('Import mode', { exact: true }).selectOption('sync');
	check(await page.getByRole('option', { name: 'Replace existing proxies', exact: true }).count() === 1, 'replace mode names its proxy scope');
	await page.getByRole('button', { name: 'Preview import', exact: true }).click();
	await page.getByText('2 entries ready · 3 copies · 0 unresolved rows', { exact: true }).waitFor();
	await page.getByRole('checkbox', { name: /Replace all 2 existing proxy copies/ }).check();
	await page.getByRole('button', { name: 'Import 3 copies', exact: true }).click();
	await page.getByRole('status').filter({ hasText: 'Imported 3 copies' }).waitFor();
	check(JSON.stringify(db.prepare("SELECT card_id,quantity,location,proxy FROM collection_cards WHERE user_id='owner' ORDER BY proxy,card_id,location").all()) === JSON.stringify([
		{ card_id: 'bolt', quantity: 3, location: 'Trades', proxy: 0 }, { card_id: 'horn', quantity: 2, location: 'Box A', proxy: 0 },
		{ card_id: 'bolt', quantity: 1, location: '', proxy: 1 }, { card_id: 'horn-p', quantity: 2, location: '', proxy: 1 }]), 'a proxy list replaces only the previous proxies');
	check(db.prepare("SELECT COUNT(*) AS n FROM collection_card_tags cct JOIN tags t ON cct.tag_id=t.id WHERE t.name='Red; Blue'").get().n === 1, 'real cards keep their tags');
	await page.getByRole('button', { name: 'Close import', exact: true }).click();
	await context.request.patch(origin + '/collection');
	check(db.prepare('SELECT COUNT(*) AS n FROM collection_cards WHERE proxy=1 AND purchase_price IS NOT NULL').get().n === 0, 'filling missing purchase prices skips proxies');
	db.prepare("INSERT INTO wishlist_cards(user_id,card_id) VALUES ('owner','horn-p')").run();
	await page.goto(origin + '/wishlist');
	check(await page.getByTitle('In collection').count() === 0 && await page.getByRole('button', { name: 'Collect', exact: true }).count() === 1, 'a card owned only as proxy can still be collected from the wishlist');
	const added = await context.request.post(origin + '/collection', { data: { cardId: 'horn', quantity: 1, proxy: true } });
	const addedRow = db.prepare("SELECT id,proxy FROM collection_cards WHERE user_id='owner' ORDER BY id DESC LIMIT 1").get();
	check(added.ok() && addedRow.proxy === 1, 'adding a card can mark it as proxy');
	await context.request.put(origin + '/collection', { data: { id: addedRow.id, quantity: 2, condition: 'near_mint', language: 'en' } });
	check(db.prepare('SELECT proxy FROM collection_cards WHERE id=?').get(addedRow.id).proxy === 1, 'an edit without the proxy field keeps the flag');
	await page.goto(origin + '/scan');
	await page.getByText(/^Scan settings ·/).click();
	await page.getByLabel('Set restriction', { exact: true }).selectOption('ori');
	await page.getByLabel('Card language', { exact: true }).selectOption('de');
	await page.getByLabel('Finish', { exact: true }).selectOption('foil');
	await page.getByLabel('Save to location', { exact: true }).fill('Box A');
	await page.reload();
	await page.getByText(/^Scan settings · ORI · DE · foil/).waitFor();
	await page.getByText(/^Scan settings ·/).click();
	check(await page.getByLabel('Save to location', { exact: true }).inputValue() === 'Box A', 'scan settings survive reload');
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'scan settings fit mobile width');
	await page.screenshot({ path: resolve(dir, 'scan-settings-mobile.png'), fullPage: true });
	await page.getByRole('button', { name: 'Reset scan settings', exact: true }).click();
	check(await page.getByLabel('Set restriction', { exact: true }).inputValue() === '', 'mixed-pile reset removes set restriction');
	check(errors.length === 0, `no browser errors: ${errors.join('; ')}`);
	console.log(`PASS ${checks} collector workflow checks. Screenshots: ${dir}`);
} finally { await browser?.close(); server.kill(); db.close(); }
