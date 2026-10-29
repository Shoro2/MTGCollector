import { describe, expect, it } from 'vitest';
import { deckLinkHelp, deckListText, parseDeckList } from './deck-text';

const brief = (text: string) => parseDeckList(text).entries.map((e) => [e.board, e.quantity, e.name, e.set, e.number, e.foil]);

describe('parseDeckList', () => {
	it('reads Moxfield and Arena lines with printings, foils and sections', () => {
		const text = `Commander
1 Kinnan, Bonder Prodigy (IKO) 192 *F*

Deck
1 Sol Ring (C21) 263
4x Lightning Bolt
1 Delver of Secrets // Insectile Aberration (ISD) 51
1 Fire/Ice

Sideboard
2 Pyroblast (ICE) 212

Maybeboard
1 Shock`;
		expect(brief(text)).toEqual([
			['commander', 1, 'Kinnan, Bonder Prodigy', 'iko', '192', true],
			['main', 1, 'Sol Ring', 'c21', '263', false],
			['main', 4, 'Lightning Bolt', '', '', false],
			['main', 1, 'Delver of Secrets // Insectile Aberration', 'isd', '51', false],
			['main', 1, 'Fire // Ice', '', '', false],
			['sideboard', 2, 'Pyroblast', 'ice', '212', false],
			['maybeboard', 1, 'Shock', '', '', false]
		]);
		expect(parseDeckList(text).implicitSideboard).toBe(false);
	});
	it('understands Moxfield "SIDEBOARD:", comment headers, SB: prefixes and Arena "About" blocks', () => {
		expect(brief('1 Island\n\nSIDEBOARD:\n1 Negate')).toEqual([['main', 1, 'Island', '', '', false], ['sideboard', 1, 'Negate', '', '', false]]);
		expect(brief('// Main Deck\n2 Opt\n// Sideboard (1)\n1 Duress\n# a comment')).toEqual([['main', 2, 'Opt', '', '', false], ['sideboard', 1, 'Duress', '', '', false]]);
		expect(brief('4 Opt\nSB: 2 Duress')).toEqual([['main', 4, 'Opt', '', '', false], ['sideboard', 2, 'Duress', '', '', false]]);
		expect(brief('About\nName Izzet Tempo\n\nDeck\n4 Opt')).toEqual([['main', 4, 'Opt', '', '', false]]);
	});
	it('treats a short second block as the MTGO sideboard, but only without headers', () => {
		const mtgo = parseDeckList('4 Opt\n56 Island\n\n2 Negate\n');
		expect(mtgo.entries.map((e) => e.board)).toEqual(['main', 'main', 'sideboard']);
		expect(mtgo.implicitSideboard).toBe(true);
		expect(parseDeckList('4 Opt\n\n\n56 Island').entries.map((e) => e.board)).toEqual(['main', 'main']);
		expect(parseDeckList('4 Opt\n\n2 Shock\n\n1 Negate').entries.map((e) => e.board)).toEqual(['main', 'main', 'main']);
	});
	it('drops Moxfield tags and uses Archidekt categories as boards', () => {
		expect(brief('1 Sol Ring (C21) 263 #Ramp #!Staple')).toEqual([['main', 1, 'Sol Ring', 'c21', '263', false]]);
		expect(brief('1x Krenko, Mob Boss (DDT) 52 [Commander{top}]\n1x Shock [Maybeboard{noDeck}]'))
			.toEqual([['commander', 1, 'Krenko, Mob Boss', 'ddt', '52', false], ['maybeboard', 1, 'Shock', '', '', false]]);
	});
	it('reports unreadable lines and quantities out of range', () => {
		const { entries, issues } = parseDeckList('0 Opt\n1000 Island\n12\n2 Island');
		expect(entries.map((e) => e.name)).toEqual(['Island']);
		expect(issues.map((i) => i.line)).toEqual([1, 2, 3]);
		expect(() => parseDeckList('1 Opt\n'.repeat(1001))).toThrow('at most 1000 lines');
	});
});

describe('deckListText', () => {
	const rows = [
		{ board: 'main' as const, quantity: 1, name: 'Sol Ring', set_code: 'c21', collector_number: '263', foil: 0 },
		{ board: 'commander' as const, quantity: 1, name: 'Kinnan, Bonder Prodigy', set_code: 'iko', collector_number: '192', foil: 1 },
		{ board: 'main' as const, quantity: 4, name: 'Arcane Signet', set_code: 'eld', collector_number: '331', foil: 0 },
		{ board: 'sideboard' as const, quantity: 1, name: 'Shock', set_code: 'm21', collector_number: '159', foil: 0 }
	];
	it('writes Arena-style sections with printings, or names only', () => {
		expect(deckListText(rows, 'printings')).toBe(
			'Commander\n1 Kinnan, Bonder Prodigy (IKO) 192 *F*\n\nDeck\n4 Arcane Signet (ELD) 331\n1 Sol Ring (C21) 263\n\nSideboard\n1 Shock (M21) 159\n'
		);
		expect(deckListText(rows, 'names')).toBe('Commander\n1 Kinnan, Bonder Prodigy\n\nDeck\n4 Arcane Signet\n1 Sol Ring\n\nSideboard\n1 Shock\n');
		expect(deckListText([], 'names')).toBe('');
	});
	it('round-trips through the parser', () => {
		const parsed = parseDeckList(deckListText(rows, 'printings')).entries;
		expect(parsed.map((e) => [e.board, e.quantity, e.name, e.set, e.number, e.foil])).toEqual([
			['commander', 1, 'Kinnan, Bonder Prodigy', 'iko', '192', true],
			['main', 4, 'Arcane Signet', 'eld', '331', false],
			['main', 1, 'Sol Ring', 'c21', '263', false],
			['sideboard', 1, 'Shock', 'm21', '159', false]
		]);
	});
});

describe('deckLinkHelp', () => {
	it('explains how to copy the list when only a deck link was pasted', () => {
		expect(deckLinkHelp('https://moxfield.com/decks/abc123XYZ')).toMatch(/^Moxfield links cannot be read\. Open the deck on Moxfield, choose More, then Export/);
		expect(deckLinkHelp('  www.moxfield.com/decks/abc?tab=primer \n')).toMatch(/^Moxfield/);
		expect(deckLinkHelp('https://archidekt.com/decks/123/goblins')).toMatch(/^Archidekt/);
		expect(deckLinkHelp('https://example.org/list')).toMatch(/not a link/);
		expect(() => parseDeckList('https://moxfield.com/decks/abc')).toThrow('Moxfield links cannot be read');
	});

	it('leaves card lists and single card names alone', () => {
		for (const text of ['Counterspell', '1 Sol Ring (C21) 263', 'B.F.M. (Big Furry Monster)', 'Fire // Ice', '4 Lightning Bolt\nhttps://moxfield.com/decks/abc']) {
			expect(deckLinkHelp(text)).toBeNull();
		}
	});
});
