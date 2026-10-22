// Build first. Decks end to end on a fresh synthetic database, never the application database:
// create with a pasted list, type groups, ownership against the viewer's collection, totals and
// format checks, editing, adding, importing, exporting, sharing by link, copying, privacy and
// deleting, on a phone-sized and a desktop-sized browser.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { SCHEMA_SQL } from '../src/lib/server/schema-sql.ts';

const dir = resolve('data', `deck-workflows-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const dbPath = resolve(dir, 'mtg.db');
const db = new Database(dbPath);
db.exec(SCHEMA_SQL);
const tokens = { owner: randomBytes(32).toString('hex'), other: randomBytes(32).toString('hex') };
db.exec(`INSERT INTO users(id,google_id,email,name) VALUES ('owner','owner','fixture@example.invalid','Fixture Owner'),('other','other','other@example.invalid','Other Player')`);
for (const [user, token] of Object.entries(tokens)) {
	db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, user, new Date(Date.now() + 86400000).toISOString());
}
const legal = (extra = {}) => JSON.stringify({ commander: 'legal', legacy: 'legal', vintage: 'legal', modern: 'legal', ...extra });
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const insert = db.prepare(`INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,mana_cost,cmc,color_identity,legalities,price_eur,layout,released_at,is_paper)
	VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'normal',?,1)`);
const CARDS = [
	[1, 'krenko', 'Krenko, Mob Boss', 'tst', '1', 'rare', 'Legendary Creature — Goblin Warrior', '{2}{R}{R}', 4, '["R"]', legal(), 3, '2024-01-01'],
	[2, 'sol', 'Sol Ring', 'tst', '2', 'uncommon', 'Artifact', '{1}', 1, '[]', legal({ legacy: 'banned', vintage: 'restricted' }), 1.5, '2024-01-01'],
	[3, 'bolt', 'Lightning Bolt', 'tst', '3', 'common', 'Instant', '{R}', 1, '["R"]', legal(), 2, '2024-01-01'],
	[4, 'bolt', 'Lightning Bolt', 'lea', '161', 'common', 'Instant', '{R}', 1, '["R"]', legal(), 300, '1993-08-05'],
	[5, 'counter', 'Counterspell', 'tst', '5', 'common', 'Instant', '{U}{U}', 2, '["U"]', legal(), 1, '2024-01-01'],
	[6, 'mountain', 'Mountain', 'tst', '6', 'common', 'Basic Land — Mountain', null, 0, '[]', legal(), 0.1, '2024-01-01'],
	[7, 'guide', 'Goblin Guide', 'tst', '7', 'rare', 'Creature — Goblin Scout', '{R}', 1, '["R"]', legal(), 4, '2024-01-01'],
	[8, 'lotus', 'Black Lotus', 'lea', '232', 'rare', 'Artifact', '{0}', 0, '[]', legal({ commander: 'banned', legacy: 'banned', vintage: 'restricted' }), null, '1993-08-05']
];
for (const [n, oracle, name, set, number, rarity, type, cost, cmc, identity, legalities, price, released] of CARDS) {
	insert.run(uuid(n), oracle, name, set, set === 'lea' ? 'Limited Edition Alpha' : 'Test Set', number, rarity, type, cost, cmc, identity, legalities, price, released);
}
db.exec("INSERT INTO cards_fts(cards_fts) VALUES('rebuild')");
// The owner has Sol Ring, two Lightning Bolts of another printing and ten proxy Mountains;
// the other player has a Counterspell.
db.exec(`INSERT INTO collection_cards(user_id,card_id,quantity,condition,language,foil,added_at,proxy) VALUES
	('owner','${uuid(2)}',1,'near_mint','en',0,'2026-01-01T00:00:00.000Z',0),
	('owner','${uuid(4)}',2,'near_mint','en',0,'2026-01-01T00:00:00.000Z',0),
	('owner','${uuid(6)}',10,'near_mint','en',0,'2026-01-01T00:00:00.000Z',1),
	('other','${uuid(5)}',1,'near_mint','en',0,'2026-01-01T00:00:00.000Z',0)`);

const port = Number(process.env.DECK_UX_PORT || 5194), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['build/index.js'], { windowsHide: true,
	env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, MTG_DB_PATH: dbPath, DISABLE_PRICE_UPDATES: '1' },
	stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', browser, checks = 0;
server.stdout.on('data', data => output += data); server.stderr.on('data', data => output += data);
function check(condition, label) { assert.ok(condition, label); checks++; console.log('PASS ' + label); }
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const owned = (page, name) => page.locator(`[data-group] li[data-row="${name}"] [data-owned]`).first().getAttribute('data-owned');

try {
	for (let i = 0; i < 150; i++) {
		if (server.exitCode != null) throw new Error(output);
		try { if ((await fetch(origin + '/api/health')).ok) break; } catch {}
		await new Promise(r => setTimeout(r, 200));
	}
	check(db.prepare("SELECT 1 FROM _schema_migrations WHERE id='0027_decks'").get(), 'migration 0027 creates the deck tables');

	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
	const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
	const ownerContext = await browser.newContext(phone);
	await ownerContext.addCookies([{ name: 'session', value: tokens.owner, url: origin }]);
	await ownerContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
	const page = await ownerContext.newPage(), errors = [];
	page.on('pageerror', error => errors.push(error.message));

	// Create a deck with a commander, a pasted list and an unknown card.
	await page.goto(origin + '/decks');
	check(await page.getByText('You have no decks yet.').count() === 1, 'empty deck list explains what to do');
	check(await page.locator('a[href="/decks"]').count() > 0, 'the menu links the decks');
	await page.getByRole('button', { name: 'Create your first deck', exact: true }).click();
	await page.getByLabel('Name', { exact: true }).fill('Krenko Goblins');
	await page.getByRole('combobox', { name: 'Commander' }).fill('Krenko');
	await page.getByRole('option', { name: /Krenko, Mob Boss/ }).click();
	await page.getByText('Unlisted', { exact: true }).click();
	await page.getByText('Paste in list', { exact: true }).click();
	await page.getByLabel('Card list', { exact: true }).fill([
		'1 Sol Ring', '4 Lightning Bolt (TST) 3', '1 Counterspell', '10 Mountain', '1 Goblin Guide', '1 Black Lotus', '1 Nonexistent Card Name',
		'', 'Sideboard', '1 Lightning Bolt'
	].join('\n'));
	await page.screenshot({ path: resolve(dir, 'create-mobile.png'), fullPage: true });
	check(await page.locator('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'create dialog fits mobile width');
	await page.getByRole('button', { name: 'Create', exact: true }).click();
	await page.getByRole('status').filter({ hasText: 'The deck was created with' }).waitFor();
	check((await page.locator('dialog').innerText()).includes('Nonexistent Card Name'), 'an unknown card is reported with its line');
	const deck = db.prepare("SELECT * FROM decks WHERE user_id='owner'").get();
	check(deck && deck.name === 'Krenko Goblins' && deck.format === 'commander' && deck.visibility === 'unlisted', 'the deck is stored with name, format and visibility');
	const boards = Object.fromEntries(db.prepare('SELECT board, SUM(quantity) AS n FROM deck_cards WHERE deck_id=? GROUP BY board').all(deck.id).map(r => [r.board, r.n]));
	check(boards.commander === 1 && boards.main === 18 && boards.sideboard === 1, 'commander, main deck and sideboard are filled from the dialog');
	check(db.prepare('SELECT card_id FROM deck_cards WHERE deck_id=? AND board=? AND card_id=?').get(deck.id, 'main', uuid(3)), 'a set and number pick that printing');
	await page.getByRole('link', { name: 'Open deck', exact: true }).click();
	await page.waitForURL(`**/decks/${deck.id}`);

	// The deck view: groups, totals, the format check and ownership.
	const groups = await page.locator('[data-group]').evaluateAll(els => els.map(el => el.getAttribute('data-group')));
	check(JSON.stringify(groups) === JSON.stringify(['commander', 'Creature', 'Instant', 'Artifact', 'Land', 'sideboard']), `cards are grouped by type with the commander first (${groups})`);
	check(await page.locator('[data-kpi="cards"]').innerText() === '19', 'the card count includes the commander');
	check(await page.locator('[data-kpi="value"]').innerText() === '€20.50', 'the value covers deck and sideboard');
	check((await page.locator('.kpi-card', { hasText: 'Value' }).innerText()).includes('1 copy without a price'), 'an unpriced card is counted, not valued at zero');
	check(await page.locator('[data-kpi="missing"]').innerText() === '€14.00', 'still to buy covers the cards missing from the collection');
	check((await page.locator('.kpi-card', { hasText: 'Still to buy' }).innerText()).includes('7 not in your collection, 10 as proxies, 1 unpriced'), 'still to buy names missing cards, proxies and gaps');
	const problems = await page.locator('[data-problems]').innerText();
	check(['Black Lotus', 'Counterspell', 'Lightning Bolt', '100'].every(word => problems.includes(word)), 'the format check names bans, colors, copies and deck size');
	check(await owned(page, 'Sol Ring') === 'owned' && await owned(page, 'Mountain') === 'proxy' && await owned(page, 'Counterspell') === 'missing', 'ownership marks: owned, proxy, missing');
	check(await owned(page, 'Lightning Bolt') === 'partial' &&
		await page.locator('[data-group="sideboard"] li[data-row="Lightning Bolt"] [data-owned]').getAttribute('data-owned') === 'missing', 'a card owned twice covers the main deck before the sideboard');
	check(await page.locator('li[data-row="Black Lotus"]').getByLabel(/Problem/).count() === 1, 'an illegal card is marked in its row');
	check(await page.locator('[data-group="sideboard"] li[data-row="Lightning Bolt"]').getByLabel(/Problem/).count() === 0, 'a commander sideboard is not marked, the rules skip it');
	await page.screenshot({ path: resolve(dir, 'deck-mobile.png'), fullPage: true });
	check(await fits(page), 'deck view fits mobile width');

	await page.getByLabel('Group by').selectOption('cmc');
	await page.waitForURL('**?group=cmc');
	check(await page.locator('[data-group="mv1"]').count() === 1 && await page.locator('[data-group="Land"]').count() === 1, 'grouping by mana value keeps lands apart');
	await page.goto(origin + `/decks/${deck.id}`);

	// Edit a row, add a card, import and export.
	await page.getByRole('button', { name: 'Edit Lightning Bolt' }).first().click();
	await page.getByLabel('Quantity', { exact: true }).fill('1');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.locator('dialog').waitFor({ state: 'detached' });
	check(db.prepare("SELECT quantity FROM deck_cards WHERE deck_id=? AND board='main' AND card_id=?").get(deck.id, uuid(3)).quantity === 1, 'editing a row changes its quantity');
	check(!(await page.locator('[data-problems]').innerText()).includes('Lightning Bolt'), 'the copy problem disappears after the edit');
	await page.getByLabel('Board for new cards').selectOption('maybeboard');
	await page.getByRole('combobox', { name: 'Add a card' }).fill('goblin gu');
	await page.getByRole('option', { name: /Goblin Guide/ }).click();
	await page.getByRole('status').filter({ hasText: 'Added Goblin Guide to the maybeboard.' }).waitFor();
	check(db.prepare("SELECT quantity FROM deck_cards WHERE deck_id=? AND board='maybeboard'").get(deck.id)?.quantity === 1, 'the search adds a card to the chosen board');
	check(await page.locator('[data-kpi="value"]').innerText() === '€14.50', 'the maybeboard is not part of the value');
	const exported = await (await ownerContext.request.get(origin + `/decks/${deck.id}/export?style=printings`)).text();
	check(exported.startsWith('Commander\n1 Krenko, Mob Boss (TST) 1\n\nDeck\n') && exported.includes('\n\nSideboard\n1 Lightning Bolt (TST) 3') && exported.includes('Maybeboard\n1 Goblin Guide (TST) 7'), 'the export lists every board with printings');
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const list = page.getByLabel('Deck list', { exact: true });
	await page.waitForFunction(() => document.querySelector('textarea[aria-label="Deck list"]')?.value.includes('(TST)'));
	check((await list.inputValue()) === exported, 'the export dialog shows the list with printings');
	await page.getByRole('tab', { name: 'Names only', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('textarea[aria-label="Deck list"]')?.value.startsWith('Commander\n1 Krenko, Mob Boss\n'));
	check(!(await list.inputValue()).includes('(TST)'), 'the names-only export leaves printings out');
	await page.getByRole('button', { name: 'Copy to clipboard', exact: true }).click();
	await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
	check((await page.evaluate(() => navigator.clipboard.readText())).startsWith('Commander\n1 Krenko'), 'the export is copied to the clipboard');
	await page.keyboard.press('Escape');
	await page.locator('dialog').waitFor({ state: 'detached' });

	// Share the unlisted deck.
	await page.getByRole('button', { name: 'Share', exact: true }).click();
	await page.getByRole('status').filter({ hasText: /Link copied|Share this link/ }).waitFor();
	const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
	check(clip === `${origin}/decks/${deck.id}` || (await page.getByRole('status').innerText()).includes(`/decks/${deck.id}`), 'sharing an unlisted deck copies its link');

	// A visitor sees the shared deck without the owner's name or collection.
	const visitorContext = await browser.newContext(phone);
	const visitor = await visitorContext.newPage();
	visitor.on('pageerror', error => errors.push(error.message));
	const anonymous = await visitor.goto(origin + `/decks/${deck.id}`);
	check(anonymous.status() === 200 && await visitor.getByRole('heading', { level: 1 }).innerText().then(t => t.includes('Krenko Goblins')), 'a visitor opens an unlisted deck by its link');
	const html = await visitor.content();
	check(!html.includes('Fixture Owner') && !html.includes('fixture@example.invalid'), 'a shared deck never shows its owner');
	check(await visitor.locator('[data-owned]').count() === 0 && await visitor.getByRole('link', { name: 'Sign in to copy' }).count() === 1, 'a visitor gets no ownership marks and a sign-in link to copy');
	check(await visitor.getByRole('button', { name: 'Settings', exact: true }).count() === 0 && await visitor.getByRole('button', { name: /^Edit / }).count() === 0, 'a visitor cannot edit the deck');
	await visitor.goto(origin + '/decks');
	check(visitor.url().endsWith('/login'), 'the deck list requires sign-in');
	check((await visitorContext.request.get(origin + '/api/decks/search?q=sol')).status() === 401, 'the card search API requires sign-in');

	// Another player sees the deck against their own collection and copies it.
	const otherContext = await browser.newContext(phone);
	await otherContext.addCookies([{ name: 'session', value: tokens.other, url: origin }]);
	const other = await otherContext.newPage();
	other.on('pageerror', error => errors.push(error.message));
	await other.goto(origin + `/decks/${deck.id}`);
	check(await owned(other, 'Counterspell') === 'owned' && await owned(other, 'Sol Ring') === 'missing', "ownership marks use the viewer's own collection");
	check(!(await other.content()).includes('Fixture Owner'), 'a signed-in viewer does not see the owner either');
	const forbidden = await otherContext.request.patch(origin + `/api/decks/${deck.id}`, { data: { name: 'Taken over' } });
	check(!forbidden.ok() && db.prepare('SELECT name FROM decks WHERE id=?').get(deck.id).name === 'Krenko Goblins', "another player cannot change someone else's deck");
	await other.getByRole('button', { name: 'Copy to my decks', exact: true }).click();
	await other.waitForURL(url => !url.pathname.endsWith(deck.id));
	const copy = db.prepare("SELECT * FROM decks WHERE user_id='other'").get();
	check(copy && copy.visibility === 'private' && copy.name === 'Krenko Goblins', 'a copy is a private deck of the viewer');
	check(db.prepare('SELECT SUM(quantity) AS n FROM deck_cards WHERE deck_id=?').get(copy.id).n === db.prepare('SELECT SUM(quantity) AS n FROM deck_cards WHERE deck_id=?').get(deck.id).n, 'the copy has every card');
	check(await other.getByRole('button', { name: 'Settings', exact: true }).count() === 1, 'the copy can be edited by its new owner');

	// Making the deck private hides it again.
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByText('Private', { exact: true }).click();
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.locator('dialog').waitFor({ state: 'detached' });
	check(db.prepare('SELECT visibility FROM decks WHERE id=?').get(deck.id).visibility === 'private', 'settings change the visibility');
	check((await visitor.goto(origin + `/decks/${deck.id}`)).status() === 404, 'a private deck is not found for visitors');
	check((await other.goto(origin + `/decks/${deck.id}`)).status() === 404, 'a private deck is not found for other players');
	check((await otherContext.request.get(origin + `/decks/${deck.id}/export`)).status() === 404, 'a private deck cannot be exported by others');
	await page.getByRole('button', { name: 'Share', exact: true }).click();
	check((await page.locator('dialog').innerText()).includes('This deck is private.'), 'sharing a private deck asks to change its visibility first');
	await page.keyboard.press('Escape');
	await page.locator('dialog').waitFor({ state: 'detached' });

	// Replace the list by import, then check the deck list and delete the deck.
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByLabel('Card list', { exact: true }).fill('Commander\n1 Krenko, Mob Boss\n\nDeck\n2 Mountain\n1 Goblin Guide');
	await page.getByText('Replace every card in the deck', { exact: true }).click();
	check(await page.getByRole('button', { name: 'Import', exact: true }).last().isDisabled(), 'replacing a deck needs a confirmation');
	await page.getByText('Remove the current cards and import this list instead.', { exact: true }).click();
	await page.locator('dialog').getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('status').filter({ hasText: 'Imported 4 cards.' }).waitFor();
	check(db.prepare('SELECT SUM(quantity) AS n FROM deck_cards WHERE deck_id=?').get(deck.id).n === 4, 'a replacing import leaves only the new list');
	await page.getByRole('button', { name: 'Done', exact: true }).click();

	await page.goto(origin + '/decks');
	const row = page.locator('tbody tr', { hasText: 'Krenko Goblins' });
	check(await row.count() === 1 && (await row.innerText()).includes('Krenko, Mob Boss'), 'the deck list shows the deck and its commander');
	await page.screenshot({ path: resolve(dir, 'decks-mobile.png'), fullPage: true });
	check(await fits(page), 'deck list fits mobile width');

	const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	await desktop.addCookies([{ name: 'session', value: tokens.other, url: origin }]);
	const wide = await desktop.newPage();
	wide.on('pageerror', error => errors.push(error.message));
	await wide.goto(origin + `/decks/${copy.id}`);
	await wide.screenshot({ path: resolve(dir, 'deck-desktop.png'), fullPage: true });
	check(await fits(wide) && await wide.getByRole('img', { name: /Mana curve/ }).count() === 1, 'desktop deck view shows the mana curve');

	await page.goto(origin + `/decks/${deck.id}`);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	check(await page.getByRole('button', { name: 'Delete deck', exact: true }).isDisabled(), 'deleting needs a confirmation');
	await page.getByText('Delete this deck and its card list.', { exact: false }).click();
	await page.getByRole('button', { name: 'Delete deck', exact: true }).click();
	await page.waitForURL('**/decks');
	check(!db.prepare('SELECT 1 FROM decks WHERE id=?').get(deck.id) && !db.prepare('SELECT 1 FROM deck_cards WHERE deck_id=?').get(deck.id), 'deleting removes the deck and its cards');
	check(db.prepare("SELECT COUNT(*) AS n FROM collection_cards WHERE user_id='owner'").get().n === 3, 'deleting a deck leaves the collection alone');
	check(errors.length === 0, `no browser errors: ${errors.join('; ')}`);
	console.log(`\n${checks} checks passed. Screenshots in ${dir}`);
} finally { await browser?.close(); server.kill(); db.close(); }
