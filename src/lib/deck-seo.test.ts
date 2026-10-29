import { describe, expect, it } from 'vitest';
import { INDEX_MIN_CARDS, colorWords, deckIndexable, deckListSeo, deckPageMeta, deckPageUrl, type DeckMetaInput } from './deck-seo';

describe('which decks search engines may index', () => {
	it('takes public decks of at least INDEX_MIN_CARDS cards that are not hidden', () => {
		expect(INDEX_MIN_CARDS).toBe(40);
		expect(deckIndexable({ visibility: 'public', hidden: false, cards: 40 })).toBe(true);
		expect(deckIndexable({ visibility: 'public', hidden: false, cards: 39 })).toBe(false);
		expect(deckIndexable({ visibility: 'public', hidden: true, cards: 100 })).toBe(false);
		expect(deckIndexable({ visibility: 'unlisted', hidden: false, cards: 100 })).toBe(false);
		expect(deckIndexable({ visibility: 'private', hidden: false, cards: 100 })).toBe(false);
	});

	it('points the canonical at the bare deck URL', () => {
		expect(deckPageUrl('AbCdEfGhIjKlMn_-')).toBe('https://mtg-collector.com/decks/AbCdEfGhIjKlMn_-');
	});
});

describe('deck snippets', () => {
	const deck: DeckMetaInput = {
		name: 'Goblin Rush', formatLabel: 'Commander', commander: 'Krenko, Mob Boss', author: 'Shoro', cards: 100, sideboard: 0,
		colors: ['R'], value: 123.4, priced: true, notable: ['Goblin Recruiter', 'Skirk Prospector', 'Goblin Matron', 'Sol Ring', 'Mountain Goat']
	};

	it('names the format and the commander in the title within 60 characters', () => {
		expect(deckPageMeta(deck).title).toBe('Goblin Rush: MTG Commander deck with Krenko, Mob Boss');
		expect(deckPageMeta({ ...deck, name: 'A rather long deck name for my goblins' }).title).toBe('A rather long deck name for my goblins: MTG Commander deck');
		expect(deckPageMeta({ ...deck, name: 'Krenko, Mob Boss tribal' }).title).toBe('Krenko, Mob Boss tribal: MTG Commander deck');
		const long = deckPageMeta({ ...deck, name: 'x'.repeat(100) }).title;
		expect(long.length).toBeLessThanOrEqual(60);
		expect(long.endsWith('…')).toBe(true);
	});

	it('states the facts, then quotes cards that fit, without dashes in its own words', () => {
		const { description } = deckPageMeta(deck);
		expect(description).toBe('Commander deck by Shoro, led by Krenko, Mob Boss: 100 cards in Red, valued at €123.40. Includes Goblin Recruiter, Skirk Prospector and Goblin Matron.');
		expect(description.length).toBeLessThanOrEqual(155);
		expect(description).not.toMatch(/[–—-]/);
	});

	it('leaves out an unknown value, a missing author and the commander of a constructed deck', () => {
		const modern = deckPageMeta({ ...deck, formatLabel: 'Modern', commander: '', author: '', cards: 60, sideboard: 15, colors: ['U', 'R'], priced: false, notable: [] });
		expect(modern).toEqual({ title: 'Goblin Rush: MTG Modern deck', description: 'Modern deck: 60 cards and 15 in the sideboard in Blue and Red.' });
	});

	it('words colors like a player would', () => {
		expect(colorWords([])).toBe('colorless');
		expect(colorWords(['W', 'U', 'B'])).toBe('White, Blue and Black');
	});
});

describe('the public deck list', () => {
	it('indexes the list and its pages, not searches, filters or other sorts', () => {
		expect(deckListSeo(new URLSearchParams(''), 1)).toEqual({ canonical: 'https://mtg-collector.com/decks', noindex: false });
		expect(deckListSeo(new URLSearchParams('view=public&page=2&utm_source=x'), 2)).toEqual({ canonical: 'https://mtg-collector.com/decks?page=2', noindex: false });
		expect(deckListSeo(new URLSearchParams('sort=updated'), 1).noindex).toBe(false);
		expect(deckListSeo(new URLSearchParams('view=public&q=goblin'), 1)).toEqual({ canonical: 'https://mtg-collector.com/decks?q=goblin', noindex: true });
		expect(deckListSeo(new URLSearchParams('format=modern'), 1).noindex).toBe(true);
		expect(deckListSeo(new URLSearchParams('sort=name'), 1).noindex).toBe(true);
	});
});
