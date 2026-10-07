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
// Simulate an existing database without the new location column.
db.exec(SCHEMA_SQL.replace(/\tadded_at TEXT,\r?\n\tlocation TEXT NOT NULL DEFAULT ''/, '\tadded_at TEXT'));
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
	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	await context.addCookies([{ name: 'session', value: token, url: origin }]);
	const page = await context.newPage(), errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(origin + '/collection');
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
	const restored = db.prepare("SELECT quantity,location,purchase_price,added_at FROM collection_cards WHERE user_id='owner' AND card_id='horn' ORDER BY location").all();
	check(JSON.stringify(restored) === JSON.stringify(owned), 'full export and re-import preserve split holdings');
	check(db.prepare("SELECT COUNT(*) AS n FROM collection_card_tags cct JOIN tags t ON cct.tag_id=t.id WHERE t.name='Red; Blue'").get().n === 2, 'full export preserves tags containing delimiters');
	await page.getByRole('button', { name: 'Close import', exact: true }).click();
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
