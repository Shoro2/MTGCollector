import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema-sql';
import {
	DECKS_SQL, DeckError, addDeckCard, cardPrintings, cardResolver, copyDeck, createDeck, deckCards, deleteDeck, importDeckList,
	listDecks, ownedCards, readableDeck, removeDeckCard, searchDeckCards, updateDeck, updateDeckCard
} from './decks';

const legal = JSON.stringify({ commander: 'legal', modern: 'legal' });
function fixture() {
	const db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	db.exec(SCHEMA_SQL);
	db.exec(DECKS_SQL);
	db.exec('CREATE TABLE card_names (name TEXT NOT NULL, lang TEXT NOT NULL, printed_name TEXT NOT NULL, PRIMARY KEY (lang, printed_name, name))');
	const insert = db.prepare(`INSERT INTO cards (id, oracle_id, name, type_line, oracle_text, cmc, color_identity, set_code, set_name, collector_number,
		rarity, released_at, image_uri, layout, legalities, price_eur, price_usd, is_paper) VALUES
		(@id, @oracle, @name, @type, @text, @cmc, @ci, @set, @set, @number, 'rare', @released, 'https://cards.scryfall.io/normal/x.jpg', @layout, @legal, @eur, NULL, @paper)`);
	const card = (id: string, oracle: string, name: string, extra: Record<string, unknown> = {}) => insert.run({
		id, oracle, name, type: 'Instant', text: '', cmc: 1, ci: '[]', set: 'tst', number: id, released: '2020-01-01', layout: 'normal', legal, eur: 1, paper: 1, ...extra
	});
	card('krenko', 'o-krenko', 'Krenko, Mob Boss', { type: 'Legendary Creature — Goblin Warrior', ci: '["R"]', cmc: 4, eur: 3 });
	card('bolt-old', 'o-bolt', 'Lightning Bolt', { set: 'lea', number: '161', released: '1993-08-05', eur: 400 });
	card('bolt-new', 'o-bolt', 'Lightning Bolt', { set: 'clu', number: '141', released: '2024-02-23', eur: 0.5, ci: '["R"]' });
	card('bolt-arena', 'o-bolt', 'Lightning Bolt', { set: 'ana', number: '1', released: '2025-01-01', paper: 0 });
	card('delver', 'o-delver', 'Delver of Secrets // Insectile Aberration', { type: 'Creature — Human Wizard // Creature — Human Insect', ci: '["U"]', layout: 'transform' });
	card('jotun', 'o-jotun', 'Jötun Grunt', { type: 'Creature — Giant Soldier', ci: '["W"]' });
	card('horn', 'o-horn', 'War Horn', { type: 'Artifact', set: 'ori', number: '243' });
	card('mountain', 'o-mountain', 'Mountain', { type: 'Basic Land — Mountain', ci: '["R"]', cmc: 0, eur: 0.1 });
	card('goblin-token', 'o-goblin', 'Goblin', { type: 'Token Creature — Goblin', layout: 'token' });
	db.exec(`INSERT INTO card_faces (card_id, face_index, name, mana_cost, type_line) VALUES ('delver', 0, 'Delver of Secrets', '{U}', 'Creature — Human Wizard'),
		('delver', 1, 'Insectile Aberration', NULL, 'Creature — Human Insect');
		INSERT INTO card_names VALUES ('War Horn', 'de', 'Kriegshorn');
		INSERT INTO cards_fts (cards_fts) VALUES ('rebuild');
		INSERT INTO users (id, google_id, email, name) VALUES ('a', 'a', 'a@example.invalid', 'A'), ('b', 'b', 'b@example.invalid', 'B');
		INSERT INTO collection_cards (user_id, card_id, quantity, proxy) VALUES ('a', 'bolt-old', 1, 0), ('a', 'bolt-new', 2, 1), ('b', 'krenko', 1, 0);`);
	return db;
}
const board = (db: Database.Database, id: string) => deckCards(db, id).map((r) => [r.board, r.quantity, r.card_id, r.foil]);

describe('resolving list lines', () => {
	it('matches names, faces, folded accents, printed names and printings', () => {
		const db = fixture();
		const resolve = cardResolver(db);
		const id = (name: string, set = '', number = '') => {
			const result = resolve({ name, set, number });
			return 'card' in result ? result.card.id : result.error;
		};
		expect(id('Lightning Bolt')).toBe('bolt-new');
		expect(id('Lightning Bolt', 'lea', '161')).toBe('bolt-old');
		expect(id('lightning bolt', 'lea', '0161')).toBe('bolt-old');
		expect(id('Delver of Secrets')).toBe('delver');
		expect(id('Insectile Aberration')).toBe('delver');
		expect(id('Jotun Grunt')).toBe('jotun');
		expect(id('Kriegshorn')).toBe('horn');
		expect(id('Goblin')).toBe('goblin-token');
		expect(id('Nonexistent Card')).toBe('No card named "Nonexistent Card".');
		const wrongPrinting = resolve({ name: 'Lightning Bolt', set: 'ori', number: '243' });
		expect(wrongPrinting).toMatchObject({ card: { id: 'bolt-new' }, note: 'ORI 243 is not a printing of Lightning Bolt; used CLU 141.' });
		expect(resolve({ name: 'Lighnting Blot', set: 'lea', number: '161' })).toMatchObject({ card: { id: 'bolt-old' } });
		db.close();
	});
});

describe('creating, sharing and copying decks', () => {
	it('creates a deck from a list, keeps the dialog commander once and reports problems', () => {
		const db = fixture();
		const result = createDeck(db, 'a', {
			name: '  Goblins  ', format: 'commander', visibility: 'unlisted', commanderId: 'krenko',
			list: '1 Krenko, Mob Boss\n4 Lightning Bolt\n1 Lightning Bolt (LEA) 161 *F*\n30 Mountain\n1 Mystery Card\nnot a card line 1 2 (x'
		});
		expect(result.added).toBe(36);
		expect(result.issues.map((i) => i.message)).toEqual(['No card named "Mystery Card".', 'No card named "not a card line 1 2 (x".']);
		expect(board(db, result.id)).toEqual([
			['commander', 1, 'krenko', 0], ['main', 4, 'bolt-new', 0], ['main', 1, 'bolt-old', 1], ['main', 30, 'mountain', 0]
		]);
		expect(readableDeck(db, result.id, null)).toMatchObject({ name: 'Goblins', visibility: 'unlisted' });
		db.close();
	});
	it('promotes an MTGO sideboard commander, but not in constructed formats', () => {
		const db = fixture();
		const edh = createDeck(db, 'a', { name: 'EDH', format: 'commander', list: '4 Lightning Bolt\n30 Mountain\n\n1 Krenko, Mob Boss' });
		expect(board(db, edh.id)[2]).toEqual(['commander', 1, 'krenko', 0]);
		const modern = createDeck(db, 'a', { name: 'Burn', format: 'modern', list: '4 Lightning Bolt\n30 Mountain\n\n1 Krenko, Mob Boss' });
		expect(board(db, modern.id)[2]).toEqual(['sideboard', 1, 'krenko', 0]);
		db.close();
	});
	it('validates names, formats and visibility', () => {
		const db = fixture();
		expect(() => createDeck(db, 'a', { name: ' ' })).toThrow(DeckError);
		expect(() => createDeck(db, 'a', { name: 'x', format: 'tiny-leaders' })).toThrow('Unknown format.');
		expect(() => createDeck(db, 'a', { name: 'x', visibility: 'friends' })).toThrow('Visibility');
		expect(() => createDeck(db, 'a', { name: 'x', commanderId: 'nope' })).toThrow('not in the catalogue');
		expect(db.prepare('SELECT COUNT(*) AS n FROM decks').get()).toEqual({ n: 0 });
		db.close();
	});
	it('hides private decks from everybody else and lets anyone copy a shared one privately', () => {
		const db = fixture();
		const { id } = createDeck(db, 'a', { name: 'Secret', list: '1 Lightning Bolt' });
		expect(readableDeck(db, id, 'b')).toBeNull();
		expect(readableDeck(db, id, null)).toBeNull();
		expect(() => copyDeck(db, 'b', id)).toThrow('Deck not found.');
		updateDeck(db, 'a', id, { visibility: 'public' });
		const copy = copyDeck(db, 'b', id);
		expect(readableDeck(db, copy, 'b')).toMatchObject({ user_id: 'b', name: 'Secret', visibility: 'private' });
		expect(board(db, copy)).toEqual([['main', 1, 'bolt-new', 0]]);
		expect(readableDeck(db, copyDeck(db, 'a', id), 'a')?.name).toBe('Secret (copy)');
		expect(() => updateDeck(db, 'b', id, { name: 'Mine now' })).toThrow('Deck not found.');
		expect(() => deleteDeck(db, 'b', id)).toThrow('Deck not found.');
		db.close();
	});
	it('lists decks with counts, value and colors, and deleting cascades', () => {
		const db = fixture();
		const { id } = createDeck(db, 'a', { name: 'Goblins', commanderId: 'krenko', list: '4 Lightning Bolt\n1 Lightning Bolt (ANA) 1\n2 Shock' });
		const [summary] = listDecks(db, 'a', 0.9);
		expect(summary).toMatchObject({ id, name: 'Goblins', format: 'commander', cards: 6, value: 6, unpriced: 0, colors: ['R'], commander: { name: 'Krenko, Mob Boss' } });
		expect(listDecks(db, 'b', 0.9)).toEqual([]);
		deleteDeck(db, 'a', id);
		expect(db.prepare('SELECT COUNT(*) AS n FROM deck_cards').get()).toEqual({ n: 0 });
		db.close();
	});
	it('removes decks with the account', () => {
		const db = fixture();
		createDeck(db, 'a', { name: 'Goblins', list: '1 Lightning Bolt' });
		db.prepare("DELETE FROM users WHERE id = 'a'").run();
		expect(db.prepare('SELECT (SELECT COUNT(*) FROM decks) + (SELECT COUNT(*) FROM deck_cards) AS n').get()).toEqual({ n: 0 });
		db.close();
	});
});

describe('editing deck entries', () => {
	it('adds, merges, moves, switches printing and removes', () => {
		const db = fixture();
		const { id } = createDeck(db, 'a', { name: 'Burn', format: 'modern' });
		addDeckCard(db, 'a', id, { cardId: 'bolt-new', quantity: 3 });
		addDeckCard(db, 'a', id, { cardId: 'bolt-new' });
		addDeckCard(db, 'a', id, { cardId: 'bolt-new', board: 'sideboard', quantity: 2 });
		expect(board(db, id)).toEqual([['main', 4, 'bolt-new', 0], ['sideboard', 2, 'bolt-new', 0]]);
		const [main, side] = deckCards(db, id);
		updateDeckCard(db, 'a', id, side.id, { board: 'main' });
		expect(board(db, id)).toEqual([['main', 6, 'bolt-new', 0]]);
		updateDeckCard(db, 'a', id, main.id, { cardId: 'bolt-old', foil: true, quantity: 2 });
		expect(board(db, id)).toEqual([['main', 2, 'bolt-old', 1]]);
		const row = deckCards(db, id)[0];
		expect(() => updateDeckCard(db, 'a', id, row.id, { cardId: 'krenko' })).toThrow('same card');
		expect(() => updateDeckCard(db, 'a', id, row.id, { quantity: 0 })).toThrow('Quantity');
		expect(() => updateDeckCard(db, 'b', id, row.id, { quantity: 1 })).toThrow('Deck not found.');
		expect(() => addDeckCard(db, 'a', id, { cardId: 'nope' })).toThrow('not in the catalogue');
		removeDeckCard(db, 'a', id, row.id);
		expect(board(db, id)).toEqual([]);
		expect(() => removeDeckCard(db, 'a', id, row.id)).toThrow('no longer in the deck');
		db.close();
	});
	it('imports into an existing deck by adding or replacing', () => {
		const db = fixture();
		const { id } = createDeck(db, 'a', { name: 'Burn', format: 'modern', list: '4 Lightning Bolt' });
		expect(importDeckList(db, 'a', id, '2 Lightning Bolt\nSideboard\n1 War Horn', 'add')).toMatchObject({ added: 3, issues: [] });
		expect(board(db, id)).toEqual([['main', 6, 'bolt-new', 0], ['sideboard', 1, 'horn', 0]]);
		importDeckList(db, 'a', id, '20 Mountain', 'replace');
		expect(board(db, id)).toEqual([['main', 20, 'mountain', 0]]);
		expect(() => importDeckList(db, 'b', id, '1 Mountain', 'add')).toThrow('Deck not found.');
		expect(() => importDeckList(db, 'a', id, '1 Opt\n'.repeat(1001), 'add')).toThrow('at most 1000 lines');
		db.close();
	});
});

describe('reads for the deck pages', () => {
	it("counts the viewer's copies of any printing, real and proxy apart", () => {
		const db = fixture();
		expect(ownedCards(db, 'a', ['o-bolt', 'o-krenko'])).toEqual(new Map([['o-bolt', { real: 1, proxy: 2 }]]));
		expect(ownedCards(db, 'b', ['o-bolt', 'o-krenko'])).toEqual(new Map([['o-krenko', { real: 1, proxy: 0 }]]));
		expect(ownedCards(db, 'a', [])).toEqual(new Map());
		db.close();
	});
	it('takes the mana cost of the front face for double-faced cards', () => {
		const db = fixture();
		const { id } = createDeck(db, 'a', { name: 'Delver', list: '1 Delver of Secrets' });
		expect(deckCards(db, id)[0]).toMatchObject({ name: 'Delver of Secrets // Insectile Aberration', mana_cost: '{U}', color_identity: ['U'] });
		db.close();
	});
	it('suggests cards by name, commanders and legal cards only when asked', () => {
		const db = fixture();
		expect(searchDeckCards(db, 'light bo').map((c) => [c.name, c.id])).toEqual([['Lightning Bolt', 'bolt-new']]);
		expect(searchDeckCards(db, 'k')).toEqual([]);
		// Names only (not the type line), and never tokens.
		expect(searchDeckCards(db, 'goblin')).toEqual([]);
		expect(searchDeckCards(db, 'mob').map((c) => c.name)).toEqual(['Krenko, Mob Boss']);
		expect(searchDeckCards(db, 'krenko', { format: 'commander', commander: true }).map((c) => c.name)).toEqual(['Krenko, Mob Boss']);
		expect(searchDeckCards(db, 'lightning', { format: 'commander', commander: true })).toEqual([]);
		db.prepare(`UPDATE cards SET legalities = '{"commander":"banned"}' WHERE oracle_id = 'o-bolt'`).run();
		expect(searchDeckCards(db, 'lightning', { format: 'commander', legal: true })).toEqual([]);
		expect(searchDeckCards(db, 'lightning', { format: 'commander' }).length).toBe(1);
		db.close();
	});
	it('lists every printing of the same card', () => {
		const db = fixture();
		expect(cardPrintings(db, 'bolt-new').map((p) => p.id)).toEqual(['bolt-arena', 'bolt-new', 'bolt-old']);
		expect(cardPrintings(db, 'nope')).toEqual([]);
		db.close();
	});
});
