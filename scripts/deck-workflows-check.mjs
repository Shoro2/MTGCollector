// Build first. Decks end to end on a fresh synthetic database, never the application database:
// create with a pasted list, type groups, ownership against the viewer's collection, totals and
// format checks, editing, adding, importing, exporting, sharing by link, copying, privacy and
// deleting, partner commanders, brackets, color frames, the deck-link help, the link filter,
// the public deck list, reports, ownership sorting, the printing preview, the author name and
// the captcha in front of a public deck, on a phone-sized and a desktop-sized browser.
// Turnstile is replaced by stand-ins: a fake widget script for the browser and a local
// siteverify endpoint for the server (TURNSTILE_VERIFY_URL), since cloud sessions cannot
// reach challenges.cloudflare.com and real keys must never be in a test.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { SCHEMA_SQL } from '../src/lib/server/schema-sql.ts';

const dir = resolve('data', `deck-workflows-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const dbPath = resolve(dir, 'mtg.db');
const db = new Database(dbPath);
db.exec(SCHEMA_SQL);
const tokens = Object.fromEntries(['owner', 'other', 'third', 'fourth'].map(user => [user, randomBytes(32).toString('hex')]));
db.exec(`INSERT INTO users(id,google_id,email,name) VALUES ('owner','owner','fixture@example.invalid','Fixture Owner'),('other','other','other@example.invalid','Other Player'),
	('third','third','third@example.invalid','Third Player'),('fourth','fourth','fourth@example.invalid','Fourth Player')`);
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
	[6, 'mountain', 'Mountain', 'tst', '6', 'common', 'Basic Land — Mountain', null, 0, '["R"]', legal(), 0.1, '2024-01-01'],
	[7, 'guide', 'Goblin Guide', 'tst', '7', 'rare', 'Creature — Goblin Scout', '{R}', 1, '["R"]', legal(), 4, '2024-01-01'],
	[8, 'lotus', 'Black Lotus', 'lea', '232', 'rare', 'Artifact', '{0}', 0, '[]', legal({ commander: 'banned', legacy: 'banned', vintage: 'restricted' }), null, '1993-08-05']
];
for (const [n, oracle, name, set, number, rarity, type, cost, cmc, identity, legalities, price, released] of CARDS) {
	insert.run(uuid(n), oracle, name, set, set === 'lea' ? 'Limited Edition Alpha' : 'Test Set', number, rarity, type, cost, cmc, identity, legalities, price, released);
}
// Partners, a hybrid, two-color and three-color cards carry Scryfall's colors and rules text.
const insertRules = db.prepare(`INSERT INTO cards(id,oracle_id,name,set_code,set_name,collector_number,rarity,type_line,mana_cost,cmc,colors,color_identity,oracle_text,legalities,price_eur,layout,released_at,is_paper)
	VALUES (?,?,?,'tst','Test Set',?,?,?,?,?,?,?,?,?,?,'normal','2024-01-01',1)`);
const PARTNER = 'Partner (You can have two commanders if both have partner.)';
for (const [n, oracle, name, rarity, type, cost, cmc, colors, text, price] of [
	[9, 'thrasios', 'Thrasios, Triton Hero', 'rare', 'Legendary Creature — Merfolk Wizard', '{G}{U}', 2, '["G","U"]', `{4}: Scry 1. Then reveal the top card of your library.\n${PARTNER}`, 2],
	[10, 'tymna', 'Tymna the Weaver', 'mythic', 'Legendary Creature — Human Cleric', '{1}{W}{B}', 3, '["B","W"]', `Lifelink\n${PARTNER}`, 5],
	[11, 'reckoner', 'Boros Reckoner', 'rare', 'Creature — Minotaur Wizard', '{R/W}{R/W}{R/W}', 3, '["R","W"]', 'Whenever Boros Reckoner is dealt damage, it deals that much damage to any target.', 0.5],
	[12, 'helix', 'Lightning Helix', 'uncommon', 'Instant', '{R}{W}', 2, '["R","W"]', 'Lightning Helix deals 3 damage to any target and you gain 3 life.', 0.4],
	[13, 'esper', 'Esper Charm', 'uncommon', 'Instant', '{W}{U}{B}', 3, '["B","U","W"]', 'Choose one — Destroy target enchantment; or draw two cards; or target player discards two cards.', 0.3]
]) {
	insertRules.run(uuid(n), oracle, name, String(n), rarity, type, cost, cmc, colors, colors, text, legal(), price);
}
// A long double-faced name: rows must truncate it instead of widening the page on a phone.
insertRules.run(uuid(15), 'esika', 'Esika, God of the Tree // The Prismatic Bridge', '15', 'mythic', 'Legendary Creature — God', '{1}{G}{G}', 3, '["G"]', '["G"]',
	'Vigilance', legal(), 2);
// A land has no colors; its frame comes from the mana it makes (its color identity).
insertRules.run(uuid(14), 'fountain', 'Hallowed Fountain', '14', 'rare', 'Land — Plains Island', null, 0, '[]', '["U","W"]',
	'({T}: Add {W} or {U}.)\nAs Hallowed Fountain enters, you may pay 2 life. If you don\'t, it enters tapped.', legal(), 8);
// Card images for the printing preview, served by the app itself.
db.prepare("UPDATE cards SET image_uri = '/favicon.ico?' || collector_number WHERE oracle_id = 'bolt'").run();
db.exec("INSERT INTO cards_fts(cards_fts) VALUES('rebuild')");
// The owner has Sol Ring, two Lightning Bolts of another printing and ten proxy Mountains;
// the other player has a Counterspell.
db.exec(`INSERT INTO collection_cards(user_id,card_id,quantity,condition,language,foil,added_at,proxy) VALUES
	('owner','${uuid(2)}',1,'near_mint','en',0,'2026-01-01T00:00:00.000Z',0),
	('owner','${uuid(4)}',2,'near_mint','en',0,'2026-01-01T00:00:00.000Z',0),
	('owner','${uuid(6)}',10,'near_mint','en',0,'2026-01-01T00:00:00.000Z',1),
	('other','${uuid(5)}',1,'near_mint','en',0,'2026-01-01T00:00:00.000Z',0)`);

// The stand-in siteverify: a token "pass:<action>:<n>" is valid once and reports its action.
const spentTokens = new Set();
const verifier = createServer((req, res) => {
	let body = '';
	req.on('data', chunk => body += chunk);
	req.on('end', () => {
		const params = new URLSearchParams(body), token = params.get('response') ?? '';
		const [kind, action] = token.split(':');
		const success = params.get('secret') === 'test-secret' && kind === 'pass' && !spentTokens.has(token);
		spentTokens.add(token);
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify(success ? { success, action } : { success: false, 'error-codes': ['invalid-input-response'] }));
	});
});
await new Promise(r => verifier.listen(0, '127.0.0.1', r));
const verifyUrl = `http://127.0.0.1:${verifier.address().port}/siteverify`;
// The stand-in widget: a button that answers with a fresh token for the widget's action.
const FAKE_TURNSTILE = `window.turnstile = (() => {
	let n = 0; const widgets = {};
	return {
		render(el, o) {
			const id = 'w' + (++n);
			const button = document.createElement('button');
			button.type = 'button'; button.textContent = 'Verify you are human'; button.dataset.fakeTurnstile = '';
			button.onclick = () => { button.textContent = 'Success'; o.callback('pass:' + o.action + ':' + Math.random().toString(36).slice(2)); };
			el.appendChild(button); widgets[id] = { el, button };
			return id;
		},
		reset(id) { widgets[id].button.textContent = 'Verify you are human'; },
		remove(id) { widgets[id]?.button.remove(); delete widgets[id]; }
	};
})();`;
const fakeTurnstile = (context) => context.route('https://challenges.cloudflare.com/**', route =>
	route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_TURNSTILE }));
const captchaCount = () => [...spentTokens].filter(t => t.includes(':publish-deck:')).length;

const port = Number(process.env.DECK_UX_PORT || 5194), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['build/index.js'], { windowsHide: true,
	env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, MTG_DB_PATH: dbPath, DISABLE_PRICE_UPDATES: '1', ADMIN_EMAIL: 'fixture@example.invalid',
		PUBLIC_TURNSTILE_SITE_KEY: 'test-site-key', TURNSTILE_SECRET_KEY: 'test-secret', TURNSTILE_VERIFY_URL: verifyUrl },
	stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', browser, checks = 0;
server.stdout.on('data', data => output += data); server.stderr.on('data', data => output += data);
function check(condition, label) { assert.ok(condition, label); checks++; console.log('PASS ' + label); }
// Two partners pass the command-zone rules, and their colors together make the identity:
// the red cards are outside it, the blue one is not.
const problemsText = (text) => !/cannot share|Cannot be a commander|At most two/.test(text) &&
	/Outside the commander's color identity: (?=.*Boros Reckoner)(?=.*Lightning Helix)(?!.*Counterspell)/.test(text);
// clientWidth, not innerWidth: a mobile browser zooms out to wider content, so innerWidth grows with it.
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
// Phone pages are checked at several common widths, not only the context's 390 px (a long card
// name widened the deck view to 417 px on every phone until 2026-10-29).
const fitsPhones = async (page) => {
	let ok = true;
	for (const width of [320, 360, 390]) {
		await page.setViewportSize({ width, height: 844 });
		await page.waitForTimeout(100);
		ok &&= await fits(page);
	}
	return ok;
};
const owned = (page, name) => page.locator(`[data-group] li[data-row="${name}"] [data-owned]`).first().getAttribute('data-owned');

try {
	for (let i = 0; i < 150; i++) {
		if (server.exitCode != null) throw new Error(output);
		try { if ((await fetch(origin + '/api/health')).ok) break; } catch {}
		await new Promise(r => setTimeout(r, 200));
	}
	check(['0027_decks', '0028_deck_bracket', '0029_deck_reports', '0030_deck_author'].every(id => db.prepare('SELECT 1 FROM _schema_migrations WHERE id=?').get(id)), 'migrations 0027 to 0030 create the deck tables');

	browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
	const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
	const ownerContext = await browser.newContext(phone);
	await fakeTurnstile(ownerContext);
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
	await page.getByText('Public', { exact: true }).click();
	await page.locator('dialog [data-fake-turnstile]').waitFor();
	check(await page.locator('dialog [data-deck-captcha] [data-fake-turnstile]').count() === 1 && await page.getByRole('button', { name: 'Create', exact: true }).isDisabled(),
		'a public deck shows the captcha and waits for it');
	await page.getByText('Unlisted', { exact: true }).click();
	check(await page.locator('dialog [data-deck-captcha]').count() === 0, 'an unlisted deck needs no captcha');
	await page.getByLabel('Author name (optional)').fill('Goblin  Tamer');
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
	check(deck && deck.name === 'Krenko Goblins' && deck.format === 'commander' && deck.visibility === 'unlisted' && deck.author_name === 'Goblin Tamer',
		'the deck is stored with name, format, visibility and author name');
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
	check(await page.locator('li[data-row="Sol Ring"] [data-owned]').getAttribute('data-printing') === 'this', 'owning the very printing is marked as such');
	check(await owned(page, 'Lightning Bolt') === 'partial' &&
		await page.locator('[data-group="sideboard"] li[data-row="Lightning Bolt"] [data-owned]').getAttribute('data-owned') === 'missing', 'a card owned twice covers the main deck before the sideboard');
	check(await page.locator('li[data-row="Black Lotus"]').getByLabel(/Problem/).count() === 1, 'an illegal card is marked in its row');
	check(await page.locator('[data-group="sideboard"] li[data-row="Lightning Bolt"]').getByLabel(/Problem/).count() === 0, 'a commander sideboard is not marked, the rules skip it');
	await page.screenshot({ path: resolve(dir, 'deck-mobile.png'), fullPage: true });
	check(await fitsPhones(page), 'deck view fits mobile width');
	check(await page.locator('[data-add-partner]').count() === 0, 'a commander without Partner gets no partner field');
	check(await page.locator('li[data-row="Sol Ring"]').first().getAttribute('data-frame') === 'colorless' &&
		await page.locator('li[data-row="Mountain"]').first().getAttribute('data-frame') === 'r' &&
		await page.locator('li[data-row="Counterspell"]').first().getAttribute('data-frame') === 'u' &&
		await page.locator('li[data-row="Krenko, Mob Boss"]').first().getAttribute('data-frame') === 'r', 'rows are framed by color: a colorless artifact grey, a Mountain red, blue, red');

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
	const bolt = page.locator('[data-group="Instant"] li[data-row="Lightning Bolt"] [data-owned]');
	check(await bolt.getAttribute('data-owned') === 'owned' && await bolt.getAttribute('data-printing') === 'other' && (await bolt.innerText()).includes('≈'), 'a copy of another printing is marked as other printing');
	await page.getByLabel('Group by').selectOption('none');
	await page.getByLabel('Sort by').selectOption('owned');
	await page.waitForURL(/sort=owned/);
	const ownedOrder = await page.locator('[data-group="main"] li[data-row]').evaluateAll(els => els.map(el => el.getAttribute('data-row')));
	check(JSON.stringify(ownedOrder) === JSON.stringify(['Sol Ring', 'Lightning Bolt', 'Mountain', 'Black Lotus', 'Counterspell', 'Goblin Guide']), `sorting by ownership: printing, other printing, proxy, missing (${ownedOrder})`);
	await page.goto(origin + `/decks/${deck.id}`);
	await page.getByRole('button', { name: 'Edit Lightning Bolt' }).first().click();
	await page.locator(`[data-printings] label[data-printing="${uuid(4)}"]`).hover();
	check(await page.locator(`img[data-printing-preview="${uuid(4)}"]`).count() === 1, 'pointing at a printing shows its image');
	await page.screenshot({ path: resolve(dir, 'printing-preview-mobile.png') });
	await page.mouse.move(0, 0);
	check(await page.locator(`img[data-printing-preview="${uuid(3)}"]`).count() === 1, 'without a pointer the chosen printing is shown');
	await page.keyboard.press('Escape');
	await page.locator('dialog').waitFor({ state: 'detached' });
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
	check((await visitor.locator('[data-deck-author]').innerText()) === 'by Goblin Tamer', 'a shared deck shows the author name its owner chose');
	check(await visitor.locator('[data-owned]').count() === 0 && await visitor.getByRole('link', { name: 'Sign in to copy' }).count() === 1, 'a visitor gets no ownership marks and a sign-in link to copy');
	check(await visitor.getByRole('button', { name: 'Settings', exact: true }).count() === 0 && await visitor.getByRole('button', { name: /^Edit / }).count() === 0, 'a visitor cannot edit the deck');
	await visitor.goto(origin + '/decks');
	check(visitor.url().endsWith('/decks') && await visitor.getByRole('heading', { level: 1 }).innerText() === 'Public decks' &&
		await visitor.locator('[data-public-total="0"]').count() === 1, 'a visitor gets the public deck list, without unlisted decks');
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
	check(await fitsPhones(page), 'deck list fits mobile width');

	const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	await desktop.addCookies([{ name: 'session', value: tokens.other, url: origin }]);
	const wide = await desktop.newPage();
	wide.on('pageerror', error => errors.push(error.message));
	await wide.goto(origin + `/decks/${copy.id}`);
	await wide.screenshot({ path: resolve(dir, 'deck-desktop.png'), fullPage: true });
	check(await fits(wide) && await wide.getByRole('img', { name: /Mana curve/ }).count() === 1, 'desktop deck view shows the mana curve');

	// Partner commanders and a bracket, on a desktop-sized browser.
	const ownerWide = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	await fakeTurnstile(ownerWide);
	await ownerWide.addCookies([{ name: 'session', value: tokens.owner, url: origin }]);
	const big = await ownerWide.newPage();
	big.on('pageerror', error => errors.push(error.message));
	await big.goto(origin + '/decks');
	await big.getByRole('button', { name: 'New deck', exact: true }).click();
	// Tailwind's preflight used to drop the dialog's margin: auto and pin it to the top left corner.
	const box = await big.locator('dialog').boundingBox();
	check(box && Math.abs(box.x + box.width / 2 - 640) < 4 && box.y > 8, `the create dialog is centred (x ${Math.round(box?.x ?? -1)}, y ${Math.round(box?.y ?? -1)}, width ${Math.round(box?.width ?? -1)})`);
	await big.getByLabel('Name', { exact: true }).fill('Thrasios and Tymna');
	check(await big.locator('[data-partner-field]').count() === 0, 'the partner field waits for a commander that can take one');
	await big.getByRole('combobox', { name: 'Commander' }).fill('Thrasios');
	await big.getByRole('option', { name: /Thrasios, Triton Hero/ }).click();
	// "th" matches Thrasios and "Tymna the Weaver"; the commander itself is never offered.
	await big.getByRole('combobox', { name: 'Partner (optional)' }).fill('th');
	const suggestions = big.getByRole('listbox', { name: 'Partner (optional) suggestions' }).getByRole('option');
	await suggestions.first().waitFor();
	const partners = await suggestions.allInnerTexts();
	check(partners.length === 1 && partners[0].includes('Tymna the Weaver'), `only cards that may pair are offered as partner (${partners.map(t => t.split('\n')[0]).join(' | ')})`);
	await big.getByRole('option', { name: /Tymna the Weaver/ }).click();
	await big.getByLabel('Bracket', { exact: true }).selectOption('3');
	await big.getByText('Paste in list', { exact: true }).click();
	await big.getByLabel('Card list', { exact: true }).fill('https://moxfield.com/decks/AbCdEf123');
	check((await big.locator('[data-link-help]').innerText()).includes('choose More, then Export') &&
		await big.getByRole('button', { name: 'Create', exact: true }).isDisabled(), 'a pasted Moxfield link explains where its text export is');
	await big.getByLabel('Card list', { exact: true }).fill('1 Sol Ring\n1 Counterspell\n1 Boros Reckoner\n1 Lightning Helix\n1 Esper Charm\n1 Hallowed Fountain\n5 Mountain');
	await big.getByRole('button', { name: 'Create', exact: true }).click();
	// A list without problems opens the new deck right away.
	await big.waitForURL(/\/decks\/[A-Za-z0-9_-]{16}$/);
	const duo = db.prepare("SELECT * FROM decks WHERE user_id='owner' AND name='Thrasios and Tymna'").get();
	check(duo.bracket === 3, 'the bracket is stored');
	check(JSON.stringify(db.prepare("SELECT card_id FROM deck_cards WHERE deck_id=? AND board='commander' ORDER BY id").all(duo.id).map(r => r.card_id)) === JSON.stringify([uuid(9), uuid(10)]), 'both partners are in the command zone');
	check(big.url().endsWith(`/decks/${duo.id}`), 'the new deck opens');
	check(await big.locator('h1 [data-bracket="3"]').innerText().then(t => t.includes('Bracket 3') && t.includes('Upgraded')), 'the bracket follows the name');
	check(await big.locator('[data-group="commander"] li').count() === 2 && await big.locator('[data-add-partner]').count() === 0, 'two commanders are listed and no third is offered');
	const frames = Object.fromEntries(await big.locator('[data-group] li[data-row]').evaluateAll(els => els.map(el => [el.getAttribute('data-row'), el.getAttribute('data-frame')])));
	check(frames['Thrasios, Triton Hero'] === 'dual' && frames['Lightning Helix'] === 'dual' && frames['Boros Reckoner'] === 'dual' && frames['Hallowed Fountain'] === 'dual' &&
		frames['Esper Charm'] === 'multi' && frames['Mountain'] === 'r' && frames['Counterspell'] === 'u', `two colors split, three gold, lands by their mana (${JSON.stringify(frames)})`);
	check(await big.locator('li[data-row="Lightning Helix"]').evaluate(el => {
		const left = getComputedStyle(el, '::before').backgroundColor, right = getComputedStyle(el, '::after').backgroundColor;
		return left !== right && left !== 'rgba(0, 0, 0, 0)' && right !== 'rgba(0, 0, 0, 0)';
	}), 'a two-color row has a stripe in each color');
	check(await big.locator('[data-group] li[data-row] a').evaluateAll(els => els.every(a => a.scrollWidth <= a.clientWidth + 1)), 'card names fit their rows on a desktop');
	check(await big.evaluate(() => getComputedStyle(document.querySelector('[data-group]').parentElement).columnCount) === '2', 'the list uses two columns next to the preview');
	check(problemsText(await big.locator('[data-problems]').innerText().catch(() => '')), 'two partners pass the command-zone check and share one color identity');
	await big.screenshot({ path: resolve(dir, 'partners-desktop.png'), fullPage: true });
	await big.getByRole('button', { name: 'Settings', exact: true }).click();
	await big.getByLabel('Bracket', { exact: true }).selectOption('4');
	await big.getByRole('button', { name: 'Save', exact: true }).click();
	await big.locator('dialog').waitFor({ state: 'detached' });
	check(db.prepare('SELECT bracket FROM decks WHERE id=?').get(duo.id).bracket === 4 && await big.locator('h1 [data-bracket="4"]').count() === 1, 'settings change the bracket');
	// Links are refused, then the deck goes public with a plain description, behind the captcha.
	await big.getByRole('button', { name: 'Settings', exact: true }).click();
	check(await big.getByLabel('Author name (optional)').inputValue() === 'Goblin Tamer', 'the create dialog filled in the author name of the first deck');
	await big.getByText('Public', { exact: true }).click();
	const save = big.getByRole('button', { name: 'Save', exact: true });
	await big.locator('dialog [data-fake-turnstile]').waitFor();
	check(await save.isDisabled() && await big.locator('dialog [data-fake-turnstile]').count() === 1, 'making a deck public waits for the captcha');
	await big.screenshot({ path: resolve(dir, 'publish-captcha-desktop.png') });
	await big.getByLabel('Description', { exact: true }).fill('Cheap singles at cardshop.com');
	await big.locator('dialog [data-fake-turnstile]').click();
	await save.click();
	await big.getByRole('alert').filter({ hasText: 'Links, web addresses and e-mail addresses are not allowed' }).waitFor();
	check(db.prepare('SELECT visibility FROM decks WHERE id=?').get(duo.id).visibility === 'private', 'a description with a link is not saved');
	check(captchaCount() === 0 && await save.isDisabled(), 'a refused description does not spend the captcha, and the widget starts over');
	await big.getByLabel('Description', { exact: true }).fill('Draw cards, gain life.');
	await big.getByLabel('Author name (optional)').fill('shop.com');
	await big.locator('dialog [data-fake-turnstile]').click();
	await save.click();
	await big.getByRole('alert').filter({ hasText: 'author names' }).waitFor();
	check(db.prepare('SELECT visibility FROM decks WHERE id=?').get(duo.id).visibility === 'private', 'an author name with a web address is not saved');
	await big.getByLabel('Author name (optional)').fill('Tamer of Partners');
	await big.locator('dialog [data-fake-turnstile]').click();
	await save.click();
	await big.locator('dialog').waitFor({ state: 'detached' });
	const published = db.prepare('SELECT visibility, description, author_name FROM decks WHERE id=?').get(duo.id);
	check(published.visibility === 'public' && published.description === 'Draw cards, gain life.' && published.author_name === 'Tamer of Partners' && captchaCount() === 1,
		'the deck is public with a plain description and author name after one passed captcha');
	await big.getByRole('button', { name: 'Settings', exact: true }).click();
	check(await big.locator('dialog [data-deck-captcha]').count() === 0, 'editing a deck that is already public needs no captcha');
	await big.keyboard.press('Escape');
	await big.locator('dialog').waitFor({ state: 'detached' });

	// The server enforces the captcha, whatever the browser sends.
	const api = (method, path, data) => ownerWide.request.fetch(origin + path, { method, data });
	const refused = async (response) => response.status() === 400 && /Verify you are human/.test((await response.json()).message);
	check(await refused(await api('POST', '/api/decks', { name: 'Spam', visibility: 'public' })), 'creating a public deck without the captcha is refused');
	check(await refused(await api('POST', '/api/decks', { name: 'Spam', visibility: 'public', captcha: 'pass:contact:1' })), 'a captcha solved for another form is refused');
	const ok = await (await api('POST', '/api/decks', { name: 'Fair deck', visibility: 'public', captcha: 'pass:publish-deck:api-1' })).json();
	check(ok.success && db.prepare('SELECT visibility FROM decks WHERE id=?').get(ok.id).visibility === 'public', 'a passed captcha creates the public deck');
	check(await refused(await api('POST', '/api/decks', { name: 'Again', visibility: 'public', captcha: 'pass:publish-deck:api-1' })), 'a captcha token works only once');
	const quiet = await (await api('POST', '/api/decks', { name: 'Quiet deck', visibility: 'private' })).json();
	check(await refused(await api('PATCH', `/api/decks/${quiet.id}`, { visibility: 'public' })), 'switching a deck to public without the captcha is refused');
	check((await api('PATCH', `/api/decks/${quiet.id}`, { visibility: 'unlisted' })).ok() && (await api('PATCH', `/api/decks/${ok.id}`, { description: 'Still public.' })).ok(),
		'unlisting a deck or editing a public one needs no captcha');
	check((await api('PATCH', `/api/decks/${quiet.id}`, { author_name: 'me@example.com' })).status() === 400, 'the API refuses an author name with an e-mail address');
	await api('DELETE', `/api/decks/${ok.id}`); await api('DELETE', `/api/decks/${quiet.id}`);
	await big.getByRole('button', { name: 'Import', exact: true }).click();
	await big.getByLabel('Card list', { exact: true }).fill('moxfield.com/decks/AbCdEf123');
	check(await big.locator('dialog [data-link-help]').count() === 1 && await big.locator('dialog').getByRole('button', { name: 'Import', exact: true }).isDisabled(), 'the import dialog explains a Moxfield link too');
	await big.keyboard.press('Escape');
	await big.locator('dialog').waitFor({ state: 'detached' });

	// A deck with one Partner commander offers the second one on its page.
	const solo = await (await ownerWide.request.post(origin + '/api/decks', { data: { name: 'Thrasios alone', format: 'commander', visibility: 'private', commanderId: uuid(9) } })).json();
	await big.goto(origin + `/decks/${solo.id}`);
	await big.getByRole('combobox', { name: /Add a partner for Thrasios/ }).fill('tymna');
	await big.getByRole('listbox').getByRole('option').first().waitFor();
	await big.getByRole('option', { name: /Tymna the Weaver/ }).click();
	await big.getByRole('status').filter({ hasText: 'Tymna the Weaver joins the command zone.' }).waitFor();
	check(await big.locator('[data-group="commander"] li').count() === 2 && await big.locator('[data-add-partner]').count() === 0, 'the partner field adds the second commander and goes away');
	await big.goto(origin + '/decks');
	const duoRow = big.locator('tbody tr', { hasText: 'Thrasios and Tymna' });
	check((await duoRow.innerText()).includes('Thrasios, Triton Hero & Tymna the Weaver') && await duoRow.locator('[data-bracket="4"]').innerText() === 'B4', 'the deck list names both commanders and the bracket');
	check(await big.getByRole('link', { name: 'Public decks', exact: true }).count() === 1, 'signed-in players switch between their decks and the public ones');

	// The public list, for visitors too, without the owner.
	await visitor.goto(origin + '/decks');
	const publicRow = visitor.locator('[data-public-decks] tbody tr', { hasText: 'Thrasios and Tymna' });
	check(await publicRow.count() === 1 && (await publicRow.innerText()).includes('Thrasios, Triton Hero & Tymna the Weaver') && await publicRow.locator('[data-bracket="4"]').count() === 1, 'the public list shows the deck, its commanders and bracket');
	check(!(await visitor.content()).includes('Fixture Owner') && await visitor.locator('[data-public-decks] tbody tr').count() === 1, 'the public list never names the owner and leaves private decks out');
	check((await publicRow.locator('[data-public-author]').innerText()).includes('by Tamer of Partners'), 'the public list shows the author name');
	await visitor.getByLabel('Search public decks').fill('tamer of');
	await visitor.getByRole('button', { name: 'Search', exact: true }).click();
	await visitor.waitForURL(/q=tamer/);
	check(await visitor.locator('[data-public-total="1"]').count() === 1, 'the public list searches author names');
	await visitor.screenshot({ path: resolve(dir, 'public-author-mobile.png'), fullPage: true });
	await visitor.getByLabel('Search public decks').fill('tymna');
	await visitor.getByRole('button', { name: 'Search', exact: true }).click();
	await visitor.waitForURL(/q=tymna/);
	check(await visitor.locator('[data-public-total="1"]').count() === 1, 'the public list searches commanders');
	await visitor.getByLabel('Format', { exact: true }).selectOption('modern');
	await visitor.waitForURL(/format=modern/);
	check(await visitor.locator('[data-public-total="0"]').count() === 1, 'the public list filters by format');
	await visitor.screenshot({ path: resolve(dir, 'public-decks-mobile.png'), fullPage: true });
	check(await fitsPhones(visitor), 'the public list fits mobile width');

	// Three accounts report the deck: it is hidden without anybody acting.
	await other.goto(origin + `/decks/${duo.id}`);
	await other.getByRole('button', { name: 'Report', exact: true }).click();
	await other.getByText('Spam or advertising', { exact: true }).click();
	await other.getByRole('button', { name: 'Send report', exact: true }).click();
	await other.getByRole('status').filter({ hasText: 'Your report is saved.' }).waitFor();
	await other.getByRole('button', { name: 'Done', exact: true }).click();
	check(await other.getByRole('button', { name: 'Reported', exact: true }).isDisabled(), 'a player reports a deck once');
	for (const user of ['third', 'fourth']) {
		const context = await browser.newContext();
		await context.addCookies([{ name: 'session', value: tokens[user], url: origin }]);
		const response = await context.request.post(origin + `/api/decks/${duo.id}/report`, { data: { reason: 'spam' } });
		check(response.ok() && (await response.json()).hidden === (user === 'fourth'), `report by ${user} is stored`);
		await context.close();
	}
	check(db.prepare('SELECT hidden_at FROM decks WHERE id=?').get(duo.id).hidden_at, 'three reports hide the deck');
	await visitor.goto(origin + '/decks');
	check(await visitor.locator('[data-public-total="0"]').count() === 1, 'a hidden deck leaves the public list');
	await visitor.goto(origin + `/decks/${duo.id}`);
	check(!(await visitor.content()).includes('Draw cards, gain life.') && await visitor.locator('[data-hidden-note]').count() === 1, 'others no longer see its description');
	check(!(await visitor.content()).includes('Tamer of Partners'), 'others no longer see its author name');
	await big.goto(origin + `/decks/${duo.id}`);
	check((await big.content()).includes('Draw cards, gain life.') && (await big.locator('[data-hidden-note]').innerText()).includes('Several players reported this deck'), 'the owner still sees it and is told why');
	// The next new deck starts with the author name the owner chose last.
	await big.goto(origin + '/decks');
	await big.getByRole('button', { name: 'New deck', exact: true }).click();
	check(await big.getByLabel('Author name (optional)').inputValue() === 'Tamer of Partners', 'the create dialog suggests the author name chosen last');
	await big.keyboard.press('Escape');
	await big.locator('dialog').waitFor({ state: 'detached' });
	check((await ownerWide.request.post(origin + `/api/decks/${duo.id}/report`, { data: { reason: 'spam' } })).status() === 400, 'an owner cannot report their own deck');
	await big.goto(origin + '/admin');
	const reportedRow = big.locator('[data-reported-decks] tr', { hasText: 'Thrasios and Tymna' });
	check((await reportedRow.innerText()).includes('hidden'), 'the admin sees the hidden deck');
	await reportedRow.getByRole('button', { name: 'Restore', exact: true }).click();
	await big.locator('[data-reported-decks]').getByText('No reports.').waitFor();
	check(!db.prepare('SELECT hidden_at FROM decks WHERE id=?').get(duo.id).hidden_at && !db.prepare('SELECT 1 FROM deck_reports WHERE deck_id=?').get(duo.id), 'restoring shows the deck again and forgets the reports');

	db.prepare("INSERT INTO deck_cards(deck_id,card_id,board,quantity) VALUES (?,?,'main',1)").run(duo.id, uuid(15));
	const phoneDuo = await ownerContext.newPage();
	await phoneDuo.goto(origin + `/decks/${duo.id}`);
	await phoneDuo.screenshot({ path: resolve(dir, 'partners-mobile.png'), fullPage: true });
	check(await fitsPhones(phoneDuo), 'the framed deck view fits mobile width, a long card name included');
	await phoneDuo.close();
	db.prepare('DELETE FROM deck_cards WHERE deck_id=? AND card_id=?').run(duo.id, uuid(15));

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
} finally { await browser?.close(); server.kill(); verifier.close(); db.close(); }
