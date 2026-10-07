// Build first. Copy catalogue tables only from an explicitly named, read-only source.
// node scripts/scanner-harness/collector-session-check.mjs data/mtg.db data/scanner-session-fixtures
// Uses the real OpenCV/OCR pipeline; scanner library assets must be reachable.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { SCHEMA_SQL } from '../../src/lib/server/schema-sql.ts';

const [catalogue, fixtures] = process.argv.slice(2);
if (!catalogue || !fixtures) throw new Error('Pass a catalogue database and the make-synthetic fixture directory.');
const dir = resolve('data', `scanner-collector-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const dbPath = resolve(dir, 'mtg.db'), target = new Database(dbPath);
const source = new Database(resolve(catalogue), { readonly: true, fileMustExist: true });
try {
	for (const table of ['cards', 'card_faces', 'card_names']) {
		const schema = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
		if (!schema) throw new Error(`Source catalogue lacks ${table}`);
		target.exec(schema.sql);
		const columns = source.prepare(`PRAGMA table_info(${table})`).all();
		const insert = target.prepare(`INSERT INTO ${table} VALUES (${columns.map(() => '?').join(',')})`);
		target.transaction(() => { for (const row of source.prepare(`SELECT * FROM ${table}`).raw().iterate()) insert.run(...row); })();
	}
} finally { source.close(); }
target.exec(SCHEMA_SQL);
const token = randomBytes(32).toString('hex');
target.exec("INSERT INTO users(id,google_id,email,name) VALUES ('fixture','fixture','scanner@example.invalid','Scanner check')");
target.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, 'fixture', new Date(Date.now() + 86400000).toISOString());
target.close();
const port = Number(process.env.SCANNER_COLLECTOR_PORT || 5194), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['build/index.js'], { windowsHide: true,
	env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, MTG_DB_PATH: dbPath, DISABLE_PRICE_UPDATES: '1' },
	stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', browser, checks = 0;
server.stdout.on('data', data => output += data); server.stderr.on('data', data => output += data);
function check(condition, label) { assert.ok(condition, label); checks++; console.log('PASS ' + label); }
async function run(script, args) {
	const child = spawn(process.execPath, [script, ...args], { windowsHide: true, stdio: 'inherit', env: { ...process.env, HARNESS_URL: origin } });
	await new Promise((yes, no) => { child.once('error', no); child.once('exit', code => code === 0 ? yes() : no(new Error(`${script} exited ${code}`))); });
}
try {
	for (let i = 0; i < 150; i++) {
		if (server.exitCode !== null) throw new Error(output);
		try { if ((await fetch(origin + '/api/health')).ok) break; } catch {}
		await new Promise(r => setTimeout(r, 200));
	}
	const expected = {
		'synth-single.jpg': [{ name: 'Lightning Bolt', set: 'm10', number: '146' }],
		'synth-grid.jpg': [{ name: 'Lightning Bolt', set: 'm10', number: '146' }, { name: 'Counterspell', set: 'mh2', number: '267' },
			{ name: 'Giant Growth', set: 'm10', number: '184' }, { name: 'Lightning Helix', set: 'rvr', number: '372' }],
		'synth-sideways.jpg': [{ name: 'Counterspell', set: 'mh2', number: '267' }]
	};
	writeFileSync(resolve(dir, 'expected.json'), JSON.stringify(expected));
	await run('scripts/scanner-harness/harness.mjs', ['--expect', resolve(dir, 'expected.json'), '--out', resolve(dir, 'results.json'),
		...Object.keys(expected).map(file => resolve(fixtures, file))]);
	const results = JSON.parse(readFileSync(resolve(dir, 'results.json'), 'utf8'));
	check(results.reduce((n, r) => n + r.metrics.identity, 0) === 6, 'unrestricted synthetic scans identify 6/6 cards');
	check(results.reduce((n, r) => n + r.metrics.printing, 0) >= 4, 'unrestricted scans retain the 4/6 printing baseline');
	check(results.every(r => r.metrics.wrongIdentity === 0 && r.metrics.wrongPrinting === 0), 'no wrong synthetic identity or printing');
	await run('scripts/scanner-harness/printing-ux-check.mjs', [resolve(fixtures, 'synth-grid.jpg')]);
	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	await context.addCookies([{ name: 'session', value: token, url: origin }]);
	const page = await context.newPage(), writes = [], errors = [];
	page.on('pageerror', error => errors.push(error.message));
	let rejectNext = true;
	await page.route('**/collection', async route => {
		if (route.request().method() !== 'POST') return route.continue();
		if (rejectNext) { rejectNext = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Temporary fixture failure"}' }); }
		writes.push(route.request().postDataJSON());
		await new Promise(r => setTimeout(r, 200));
		await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
	});
	await page.goto(origin + '/scan');
	await page.getByText(/^Scan settings ·/).click();
	await page.getByLabel('Set restriction', { exact: true }).selectOption('m10');
	await page.getByLabel('Card language', { exact: true }).selectOption('de');
	await page.getByLabel('Finish', { exact: true }).selectOption('foil');
	await page.getByLabel('Condition', { exact: true }).selectOption('lightly_played');
	await page.getByLabel('Save to location', { exact: true }).fill('Box A');
	async function scan(file) {
		const newPhoto = page.getByRole('button', { name: 'Scan new photo', exact: true });
		if (await newPhoto.count()) await newPhoto.click();
		await page.setInputFiles('input[type=file]', resolve(fixtures, file));
		await page.waitForFunction(() => /Done!|Error:/.test(document.body.innerText), null, { timeout: 120000 });
	}
	await scan('synth-single.jpg');
	const card = page.locator('[data-state="confirmed"][data-printing-state="confirmed"]').filter({ hasText: 'Lightning Bolt' });
	check(await card.count() === 1 && await card.getAttribute('data-finish') === 'foil', 'session set and foil preference apply to the captured card');
	await page.getByRole('button', { name: 'Reset scan settings', exact: true }).click();
	await card.getByRole('button', { name: 'Add', exact: true }).click();
	await page.getByRole('alert').filter({ hasText: 'Temporary fixture failure' }).waitFor();
	check(await card.getByText('Added!', { exact: true }).count() === 0, 'failed save is visible and remains retryable');
	await card.getByRole('button', { name: 'Add', exact: true }).evaluate(el => { el.click(); el.click(); });
	await card.getByText('Added!', { exact: true }).waitFor();
	check(writes.length === 1, 'rapid repeated Add produces one request');
	check(writes[0].language === 'de' && writes[0].foil === true && writes[0].condition === 'lightly_played' && writes[0].location === 'Box A',
		'save uses captured settings even after the session settings changed');
	await page.screenshot({ path: resolve(dir, 'scan-review-mobile.png'), fullPage: true });
	check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'scan review fits mobile width');
	await scan('synth-single.jpg');
	await card.getByRole('button', { name: 'Add', exact: true }).click();
	await card.getByText('Added!', { exact: true }).waitFor();
	check(writes.length === 2 && writes[1].cardId === writes[0].cardId, 'a second capture of the same printing adds another copy');
	check(writes[1].location === '' && writes[1].condition === 'near_mint', 'subsequent capture uses the reset defaults');
	await page.getByLabel('Set restriction', { exact: true }).selectOption('ori');
	await scan('synth-single.jpg');
	const conflict = page.locator('[data-state="conflict"]').filter({ hasText: 'Lightning Bolt' });
	check(await conflict.count() === 1 && await conflict.getByRole('button', { name: 'Add', exact: true }).count() === 0,
		'contrary session set requires review and cannot be silently added');
	check(errors.length === 0, `no browser errors: ${errors.join('; ')}`);
	console.log(`PASS ${checks} scanner collector checks. Results: ${dir}`);
} finally { await browser?.close(); server.kill(); }
