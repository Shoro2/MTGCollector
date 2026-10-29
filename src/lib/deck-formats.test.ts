import { describe, expect, it } from 'vitest';
import { canHavePartner, canLead, canPair, checkDeck, copyLimit, deckFormat, DECK_FORMATS, type RuleCard } from './deck-formats';
import type { Board } from './deck';

const legal = (formats: string[], status = 'legal') => Object.fromEntries(formats.map((f) => [f, status]));
const ALL = DECK_FORMATS.map((f) => f.key).filter((k) => k !== 'casual');
function card(name: string, extra: Partial<RuleCard> = {}): RuleCard {
	return { board: 'main', quantity: 1, name, type_line: 'Instant', oracle_text: '', legalities: legal(ALL), color_identity: [], ...extra };
}
const basics = (n: number, board: Board = 'main') => card('Forest', { quantity: n, board, type_line: 'Basic Land — Forest', color_identity: ['G'] });
const kinds = (cards: RuleCard[], format: string) => checkDeck(cards, format).problems.map((p) => p.kind);

describe('copy limits and leaders', () => {
	it('exempts basic lands and cards that say so', () => {
		expect(copyLimit({ type_line: 'Basic Snow Land — Island', oracle_text: '' }, 1)).toBe(Infinity);
		expect(copyLimit({ type_line: 'Creature — Rat', oracle_text: 'A deck can have any number of cards named Relentless Rats.' }, 4)).toBe(Infinity);
		expect(copyLimit({ type_line: 'Creature — Dwarf', oracle_text: 'A deck can have up to seven cards named Seven Dwarves.' }, 4)).toBe(7);
		expect(copyLimit({ type_line: 'Legendary Land', oracle_text: '' }, 4)).toBe(4);
	});
	it('knows who may lead which command zone', () => {
		const legend = { type_line: 'Legendary Creature — Elf', oracle_text: '' };
		const walker = { type_line: 'Legendary Planeswalker — Teferi', oracle_text: '' };
		const commanderWalker = { type_line: 'Legendary Planeswalker — Grist', oracle_text: 'Grist can be your commander.' };
		expect(canLead(legend, 'legendary')).toBe(true);
		expect(canLead(walker, 'legendary')).toBe(false);
		expect(canLead(commanderWalker, 'legendary')).toBe(true);
		expect(canLead(walker, 'legendary-or-planeswalker')).toBe(true);
		expect(canLead({ type_line: 'Creature — Elf', oracle_text: '' }, 'creature')).toBe(true);
		expect(canLead(walker, 'oathbreaker')).toBe(true);
		expect(canLead({ type_line: 'Legendary Creature — Bird // Legendary Land', oracle_text: '' }, 'legendary')).toBe(true);
	});
	it('pairs partners, named partners, Backgrounds and Doctors only', () => {
		const partner = (name: string) => ({ name, type_line: 'Legendary Creature — Human', oracle_text: 'Partner (You can have two commanders if both have partner.)' });
		expect(canPair(partner('Thrasios'), partner('Tymna'))).toBe(true);
		const pir = { name: 'Pir, Imaginative Rascal', type_line: 'Legendary Creature — Human', oracle_text: 'Partner with Toothy, Imaginary Friend (When this creature enters, ...)' };
		const toothy = { name: 'Toothy, Imaginary Friend', type_line: 'Legendary Creature — Illusion', oracle_text: 'Partner with Pir, Imaginative Rascal (When this creature enters, ...)' };
		expect(canPair(pir, toothy)).toBe(true);
		expect(canPair(pir, partner('Tymna'))).toBe(false);
		const chooser = { name: 'Wilson', type_line: 'Legendary Creature — Bear', oracle_text: 'Choose a Background (You can have a Background as a second commander.)' };
		const background = { name: 'Raised by Giants', type_line: 'Legendary Enchantment — Background', oracle_text: '' };
		expect(canPair(background, chooser)).toBe(true);
		const companion = { name: 'Rose Tyler', type_line: 'Legendary Creature — Human', oracle_text: "Doctor's companion (You can have two commanders if the other is the Doctor.)" };
		expect(canPair(companion, { name: 'The Tenth Doctor', type_line: 'Legendary Creature — Time Lord Doctor', oracle_text: '' })).toBe(true);
		expect(canPair(companion, partner('Tymna'))).toBe(false);
		const survivor = (name: string) => ({ name, type_line: 'Legendary Creature', oracle_text: 'Partner—Survivors (You can have two commanders if both have this ability.)' });
		expect(canPair(survivor('A'), survivor('B'))).toBe(true);
	});
	it('knows which commanders can take a second card', () => {
		const legend = (oracle_text: string, type_line = 'Legendary Creature — Human') => ({ type_line, oracle_text });
		expect(canHavePartner(legend('Flying\nPartner (You can have two commanders if both have partner.)'))).toBe(true);
		expect(canHavePartner(legend('Partner with Toothy, Imaginary Friend (When this creature enters, ...)'))).toBe(true);
		expect(canHavePartner(legend('Partner—Survivors (You can have two commanders if both have this ability.)'))).toBe(true);
		expect(canHavePartner(legend('Friends forever (You can have two commanders if both have friends forever.)'))).toBe(true);
		expect(canHavePartner(legend('Choose a Background (You can have a Background as a second commander.)'))).toBe(true);
		expect(canHavePartner(legend("Doctor's companion (You can have two commanders if the other is the Doctor.)"))).toBe(true);
		expect(canHavePartner(legend('', 'Legendary Creature — Time Lord Doctor'))).toBe(true);
		expect(canHavePartner(legend('Whenever a creature you control with partner attacks, draw a card.'))).toBe(false);
		expect(canHavePartner(legend(''))).toBe(false);
	});
});

describe('checkDeck: Commander', () => {
	const commander = card('Ezuri, Renegade Leader', { board: 'commander', type_line: 'Legendary Creature — Elf Warrior', color_identity: ['G'] });
	it('accepts 100 singleton cards in the commander colors', () => {
		const deck = [commander, basics(90), ...Array.from({ length: 9 }, (_, i) => card(`Elf ${i}`, { color_identity: ['G'] }))];
		expect(checkDeck(deck, 'commander').problems).toEqual([]);
	});
	it('reports size, copies, bans, identity and a missing commander', () => {
		const deck = [
			commander, basics(80),
			card('Llanowar Elves', { quantity: 2, color_identity: ['G'] }),
			card('Counterspell', { color_identity: ['U'] }),
			card('Mana Crypt', { legalities: { commander: 'banned' } }),
			card('Alchemy Thing', { legalities: { commander: 'not_legal' } })
		];
		const { problems } = checkDeck(deck, 'commander');
		expect(problems.map((p) => p.kind)).toEqual(['size', 'copies', 'banned', 'not_legal', 'identity']);
		expect(problems[0].message).toBe('The deck has 86 cards; Commander needs exactly 100, the command zone included.');
		expect(problems.find((p) => p.kind === 'copies')?.cards).toEqual(['Llanowar Elves']);
		expect(problems.find((p) => p.kind === 'identity')?.cards).toEqual(['Counterspell']);
		expect(kinds([basics(99), card('Sol Ring')], 'commander')).toEqual(['commander']);
	});
	it('checks the command zone and ignores sideboard and maybeboard', () => {
		const tymna = card('Tymna', { board: 'commander', type_line: 'Legendary Creature — Human', oracle_text: 'Partner (...)', color_identity: ['W', 'B'] });
		const thrasios = card('Thrasios', { board: 'commander', type_line: 'Legendary Creature — Triton', oracle_text: 'Partner (...)', color_identity: ['G', 'U'] });
		const side = card('Banned Card', { board: 'sideboard', legalities: { commander: 'banned' }, color_identity: ['R'] });
		const maybe = card('Maybe', { board: 'maybeboard', quantity: 7 });
		expect(checkDeck([tymna, thrasios, basics(98), side, maybe], 'commander').problems).toEqual([]);
		const bear = card('Grizzly Bears', { board: 'commander', type_line: 'Creature — Bear', color_identity: ['G'] });
		expect(kinds([bear, basics(99)], 'commander')).toEqual(['commander']);
		expect(kinds([tymna, bear, basics(98)], 'commander')).toEqual(['commander', 'commander']);
		const plains = card('Plains', { quantity: 98, type_line: 'Basic Land — Plains', color_identity: ['W'] });
		expect(kinds([{ ...tymna, quantity: 2 }, plains], 'commander')).toEqual(['copies', 'commander']);
	});
	it('reports cards without legality data as unchecked, not as problems', () => {
		const result = checkDeck([commander, basics(98), card('Old Card', { legalities: null })], 'commander');
		expect(result.problems).toEqual([]);
		expect(result.unchecked).toEqual(['Old Card']);
	});
});

describe('checkDeck: other formats', () => {
	it('constructed: at least 60, four copies, sideboard of 15, no command zone', () => {
		const deck = [card('Lightning Bolt', { quantity: 4 }), basics(56)];
		expect(checkDeck(deck, 'modern').problems).toEqual([]);
		expect(kinds([card('Lightning Bolt', { quantity: 3 }), card('Lightning Bolt', { quantity: 2, board: 'sideboard' }), basics(57)], 'modern')).toEqual(['copies']);
		expect(kinds([...deck, basics(16, 'sideboard')], 'modern')).toEqual(['sideboard']);
		expect(kinds([basics(50)], 'standard')).toEqual(['size']);
		expect(kinds([...deck, card('Krenko', { board: 'commander' })], 'legacy')).toEqual(['commander']);
	});
	it('vintage: restricted cards once', () => {
		const deck = [card('Sol Ring', { legalities: { vintage: 'restricted' } }), basics(59)];
		expect(checkDeck(deck, 'vintage').problems).toEqual([]);
		expect(checkDeck([{ ...deck[0], quantity: 2 }, basics(58)], 'vintage').problems[0]).toMatchObject({ kind: 'restricted', cards: ['Sol Ring'] });
	});
	it('pauper commander: an uncommon creature leads, restricted cards only in the command zone', () => {
		const leader = card('Uncommon Elf', { board: 'commander', type_line: 'Creature — Elf', legalities: { paupercommander: 'restricted' }, color_identity: ['G'] });
		expect(checkDeck([leader, basics(99)], 'paupercommander').problems).toEqual([]);
		const inMain = card('Uncommon Bear', { legalities: { paupercommander: 'restricted' } });
		expect(checkDeck([leader, basics(98), inMain], 'paupercommander').problems[0]).toMatchObject({ kind: 'restricted', cards: ['Uncommon Bear'] });
	});
	it('oathbreaker: a planeswalker and a signature spell in 60 cards', () => {
		const walker = card('Jace', { board: 'commander', type_line: 'Legendary Planeswalker — Jace', color_identity: ['U'] });
		const spell = card('Brainstorm', { board: 'commander', type_line: 'Instant', color_identity: ['U'] });
		const island = card('Island', { quantity: 58, type_line: 'Basic Land — Island', color_identity: ['U'] });
		expect(checkDeck([walker, spell, island], 'oathbreaker').problems).toEqual([]);
		expect(kinds([walker, { ...island, quantity: 59 }], 'oathbreaker')).toEqual(['commander']);
		expect(kinds([walker, { ...spell, color_identity: ['R'] }, island], 'oathbreaker')).toEqual(['identity']);
	});
	it('brawl accepts a planeswalker commander; gladiator has none; casual checks nothing', () => {
		const walker = card('Teferi', { board: 'commander', type_line: 'Legendary Planeswalker — Teferi', color_identity: ['W', 'U'] });
		expect(checkDeck([walker, basics(59)], 'standardbrawl').problems.map((p) => p.kind)).toEqual(['identity']);
		expect(kinds([walker, card('Plains', { quantity: 59, type_line: 'Basic Land — Plains', color_identity: ['W'] })], 'standardbrawl')).toEqual([]);
		expect(kinds([basics(100)], 'gladiator')).toEqual([]);
		expect(kinds([walker, basics(99)], 'gladiator')).toEqual(['commander']);
		expect(checkDeck([card('Anything', { quantity: 40, legalities: { modern: 'banned' } })], 'casual').problems).toEqual([]);
		expect(deckFormat('nonsense').key).toBe('casual');
	});
});
