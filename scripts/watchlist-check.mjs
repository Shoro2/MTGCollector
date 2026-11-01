// Build first. Price watchlists (/watchlist) on a fresh synthetic database, never the
// application database: visitors are sent to sign in, a printing page adds a card ("Watch
// price"), the list shows price, changes and the 90-day line, the card search adds a foil
// printing, duplicates are refused, a target price is marked when reached, lists are created,
// renamed and deleted and entries moved between them, sorting lives in the URL, a dollar account
// sees TCGplayer prices (and a euro price where TCGplayer has none, never converted), another
// account's list is a 404, and the page fits phones from 320 px.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { SCHEMA_SQL } from '../src/lib/server/schema-sql.ts';

const dir = resolve('data', `watchlist-check-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const dbPath = resolve(dir, 'mtg.db');
const db = new Database(dbPath);
db.exec(SCHEMA_SQL);

const HORN = '11111111-1111-4111-8111-111111111111';
const BOLT = '22222222-2222-4222-8222-222222222222';
const BOLT_OLD = '33333333-3333-4333-8333-333333333333';
const RING = '44444444-4444-4444-8444-444444444444';
const tokens = { owner: randomBytes(32).toString('hex'), dollar: randomBytes(32).toString('hex'), other: randomBytes(32).toString('hex') };
db.exec(`INSERT INTO users(id,google_id,email,name,currency) VALUES ('owner','owner','owner@example.invalid','Owner','EUR'),
		('dollar','dollar','dollar@example.invalid','Dollar','USD'), ('other','other','other@example.invalid','Other','EUR');
	INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,layout,image_uri,price_eur,price_eur_foil,price_usd,price_usd_foil,is_paper,released_at) VALUES
	('${HORN}','oracle-horn','War Horn','ori','Magic Origins','243','uncommon','Artifact','normal','https://cards.scryfall.io/normal/front/1/1/${HORN}.jpg?1',5,NULL,6,NULL,1,'2015-07-17'),
	('${BOLT}','oracle-bolt','Lightning Bolt','clu','Clue Edition','141','common','Instant','normal','https://cards.scryfall.io/normal/front/2/2/${BOLT}.jpg?1',3,12,NULL,NULL,1,'2024-02-23'),
	('${BOLT_OLD}','oracle-bolt','Lightning Bolt','m10','Magic 2010','146','common','Instant','normal','https://cards.scryfall.io/normal/front/3/3/${BOLT_OLD}.jpg?1',2,8,2.5,9,1,'2009-07-17'),
	('${RING}','oracle-ring','Sol Ring','c21','Commander 2021','263','uncommon','Artifact','normal','https://cards.scryfall.io/normal/front/4/4/${RING}.jpg?1',1,NULL,1.5,NULL,1,'2021-04-23');
	INSERT INTO cards_fts(cards_fts) VALUES ('rebuild');`);
const session = db.prepare('INSERT INTO sessions VALUES (?,?,?)');
for (const [user, token] of Object.entries(tokens)) session.run(token, user, new Date(Date.now() + 86400000).toISOString());

// Updates relative to today: War Horn 3 -> 4 -> 5 (the last move is the "day"), the foil Bolt 10 -> 12.
const dayAt = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const snapshot = db.prepare(`INSERT INTO price_history(card_id,language,snapshot_date,recorded_at,price_eur,price_eur_foil,price_usd,price_usd_foil)
	VALUES (?,'en',?,?,?,?,?,?)`);
for (const [offset, horn, boltFoil] of [[40, 3, 10], [2, 4, 10], [1, 5, 12]]) {
	const d = dayAt(offset);
	snapshot.run(HORN, d, `${d}T18:00:00Z`, horn, null, horn + 1, null);
	snapshot.run(BOLT, d, `${d}T18:00:00Z`, 3, boltFoil, null, null);
	snapshot.run(RING, d, `${d}T18:00:00Z`, 1, null, 1.5, null);
}
db.close();

const port = Number(process.env.WATCHLIST_CHECK_PORT || 5199), origin = `http://127.0.0.1:${port}`;
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
	// The server has run migration 0034 now; give the other account its list.
	const live = new Database(dbPath);
	live.prepare("INSERT INTO watchlists(user_id,name,created_at,updated_at) VALUES ('other','Private',?,?)").run(new Date().toISOString(), new Date().toISOString());
	const otherListId = live.prepare("SELECT id FROM watchlists WHERE user_id = 'other'").get().id;
	live.close();

	const visitorAnswer = await fetch(origin + '/watchlist', { redirect: 'manual' });
	check(visitorAnswer.status === 302 && visitorAnswer.headers.get('location') === '/login', 'a visitor is sent to sign in');
	check((await fetch(origin + '/api/watchlists/cards', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ cardId: HORN }) })).status === 401,
		'the API refuses visitors');

	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
	const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	await owner.addCookies([{ name: 'session', value: tokens.owner, url: origin }]);
	const page = await owner.newPage(), errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|ERR_/.test(message.text())) errors.push(message.text()); });
	const settled = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(250); };

	await page.goto(origin + '/watchlist');
	check(await page.locator('[data-empty]').isVisible(), 'an account without lists sees how to start');
	check(await page.locator('nav a[href="/watchlist"]').count() > 0, 'the menu links the watchlist');

	// From a printing page
	await page.goto(`${origin}/cards/${HORN}`);
	await page.locator('[data-watch-open]').click();
	check(await page.locator('[data-watch-list] option').first().innerText() === 'Watchlist (new)', 'without a list the first one is offered as new');
	await page.locator('[data-watch-submit]').click();
	await page.locator('[data-watched]').waitFor();
	check((await page.locator('[data-watched]').innerText()).includes('Watched in Watchlist'), 'the printing page says where the card is watched');
	await page.locator('[data-watch-price]').screenshot({ path: resolve(dir, 'printing-watch.png') });

	await page.locator('[data-watched] a').click();
	await page.waitForURL('**/watchlist?list=*');
	await settled();
	const horn = page.locator(`[data-watch-table] [data-watch-row="${HORN}"]`);
	check(await horn.locator('[data-price]').innerText() === '€5.00', 'the list shows the current Cardmarket price');
	{ const day = (await horn.locator('[data-change="day"]').innerText()).replace(/\s+/g, ''); check(day === '+€1.00+25.0%', `and the move since the update before (${day})`); }
	check(await horn.locator('[data-spark] path').count() === 1, 'and a 90-day line');
	check(await page.locator('[data-kpi="value"]').innerText() === '€5.00' && await page.locator('[data-kpi="day"]').innerText() === '+€1.00', 'the totals of the list');

	// From the search, a foil printing
	await page.locator('[role="combobox"], input[aria-autocomplete]').first().fill('Lightning');
	await page.locator('[role="option"]').first().click();
	await page.locator('[data-add-printing]').waitFor();
	await page.waitForFunction(() => document.querySelectorAll('[data-add-printing] option').length === 2);
	await page.locator('[data-add-printing]').selectOption(BOLT);
	await page.locator('[data-add-foil]').check();
	await page.locator('[data-add-submit]').click();
	await page.locator(`[data-watch-table] [data-watch-row="${BOLT}"][data-foil="1"]`).waitFor();
	const bolt = page.locator(`[data-watch-table] [data-watch-row="${BOLT}"]`);
	check(await bolt.locator('[data-price]').innerText() === '€12.00', 'the search adds a foil printing at its foil price');
	check((await bolt.locator('[data-change="day"]').innerText()).startsWith('+€2.00'), 'with the foil price move');

	await page.locator('[role="combobox"], input[aria-autocomplete]').first().fill('Lightning');
	await page.locator('[role="option"]').first().click();
	await page.waitForFunction(() => document.querySelectorAll('[data-add-printing] option').length === 2);
	await page.locator('[data-add-printing]').selectOption(BOLT);
	await page.locator('[data-add-foil]').check();
	await page.locator('[data-add-submit]').click();
	await page.locator('[role="alert"]').waitFor();
	check((await page.locator('[role="alert"]').innerText()).includes('already on the list'), 'the same printing and finish is refused');

	// A target price
	await horn.locator('[data-edit]').click();
	await page.locator('[data-edit-target]').fill('5.50');
	await page.locator('[data-edit-notes]').fill('Buy for the deck');
	await page.locator('[data-edit-save]').click();
	await page.locator(`[data-watch-table] [data-watch-row="${HORN}"] [data-target="reached"]`).waitFor();
	check(await page.locator('[data-kpi="targets"]').innerText() === '1', 'a target at or below the price is marked as reached');
	check((await horn.innerText()).includes('Buy for the deck'), 'the note is shown');

	// Sorting
	await page.locator('[data-sort="price"]').click();
	await page.waitForURL('**sort=price&dir=desc');
	await settled();
	const order = await page.locator('[data-watch-table] [data-watch-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-watch-row')));
	check(order[0] === BOLT && order[1] === HORN, 'sorting by price lives in the URL');

	// A second list, moving an entry, renaming and deleting
	await page.locator('[data-new-list]').click();
	await page.locator('[data-new-list-name]').fill('Sell soon');
	await page.locator('[data-new-list-name]').press('Enter');
	await page.waitForURL(/list=\d+$/);
	await settled();
	check(await page.locator('[data-empty-list]').isVisible(), 'a new list opens empty');
	const secondUrl = page.url();
	await page.locator('[data-watchlists] a').first().click();
	await settled();
	await page.locator(`[data-watch-table] [data-watch-row="${BOLT}"] [data-edit]`).click();
	await page.locator('[data-edit-list]').selectOption({ label: 'Sell soon' });
	await page.locator('[data-edit-save]').click();
	await page.waitForFunction((id) => !document.querySelector(`[data-watch-table] [data-watch-row="${id}"]`), BOLT);
	await page.goto(secondUrl);
	check(await page.locator(`[data-watch-table] [data-watch-row="${BOLT}"]`).count() === 1, 'an entry moves to another list');
	await page.getByRole('button', { name: 'Rename' }).click();
	await page.locator('dialog[open] input').fill('Sell');
	await page.locator('dialog[open] button[type="submit"]').click();
	await page.waitForFunction(() => [...document.querySelectorAll('[data-watchlists] a')].some((a) => a.textContent.includes('Sell') && !a.textContent.includes('soon')));
	check(true, 'a list is renamed');

	// Remove an entry, then delete a list
	await page.locator(`[data-watch-table] [data-watch-row="${BOLT}"] [data-remove]`).click();
	await page.locator('[data-empty-list]').waitFor();
	check(true, 'an entry is removed');
	await page.getByRole('button', { name: 'Delete list' }).click();
	await page.locator('[data-delete-confirm]').click();
	await page.waitForURL(origin + '/watchlist');
	await settled();
	check(await page.locator('[data-watchlists] a').count() === 1, 'a list is deleted');

	// Someone else's list
	check((await page.goto(`${origin}/watchlist?list=${otherListId}`)).status() === 404, "another account's list is a 404");
	const sneak = await page.evaluate(async ([id, card]) => (await fetch('/api/watchlists/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId: card, listId: id }) })).status, [otherListId, HORN]);
	check(sneak === 404, "nobody adds to another account's list");

	await page.goto(origin + '/settings');
	check(await page.locator('[data-watch-count]').innerText() === '1', 'the settings count watched printings');
	check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
	await page.goto(origin + '/watchlist');
	await page.screenshot({ path: resolve(dir, 'watchlist-desktop.png'), fullPage: true });

	// An account in dollars
	const dollar = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	await dollar.addCookies([{ name: 'session', value: tokens.dollar, url: origin }]);
	const usd = await dollar.newPage();
	await usd.goto(origin + '/watchlist');
	for (const [card, foil] of [[HORN, false], [BOLT, true], [RING, false]]) {
		await usd.evaluate(async ([c, f]) => fetch('/api/watchlists/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId: c, foil: f }) }), [card, foil]);
	}
	await usd.goto(origin + '/watchlist');
	check(await usd.locator(`[data-watch-table] [data-watch-row="${HORN}"] [data-price]`).innerText() === '$6.00', 'a dollar account sees the TCGplayer price');
	const boltUsd = usd.locator(`[data-watch-table] [data-watch-row="${BOLT}"]`);
	check(await boltUsd.locator('[data-price]').innerText() === '€12.00' && (await boltUsd.innerText()).includes('no TCGplayer price'),
		'without a TCGplayer price the Cardmarket price is shown in euros, never converted');
	check((await usd.locator('[data-kpi="value"]').innerText()).startsWith('$'), 'the list total is in dollars');

	// Phones
	for (const width of [320, 360, 390]) {
		const phone = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
		await phone.addCookies([{ name: 'session', value: tokens.dollar, url: origin }]);
		const p = await phone.newPage();
		await p.goto(origin + '/watchlist');
		await p.waitForTimeout(300);
		const fits = await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
		check(fits && await p.locator('[data-watch-cards] [data-watch-card]').count() === 3 && !(await p.locator('[data-watch-table]').isVisible()),
			`at ${width} px the list is cards without sideways scrolling`);
		if (width === 360) await p.screenshot({ path: resolve(dir, 'watchlist-phone-360.png'), fullPage: true });
		await p.goto(`${origin}/cards/${HORN}`);
		await p.waitForTimeout(300);
		check(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `the printing page with "Watch price" fits ${width} px`);
		await phone.close();
	}
	console.log(`${checks} checks passed; screenshots in ${dir}`);
} finally {
	await browser?.close();
	server.kill();
}
